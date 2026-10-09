// SEC-32② 的承重前提：SQLCipher 密钥由档位决定，拿错档位=打不开
//
// 上面几份测试用的是 dbService 桩；这里用真实的
// better-sqlite3-multiple-ciphers + 与应用相同的 pragma 序列，
// 钉死三件事：
// 1. 2^17 档建的库，用 2^15 档派生的密钥**打不开**（所以档位必须随库落盘）
// 2. 同一库用 2^17 档能开、数据完好（旧库升档前也照此逻辑保持可用）
// 3. 2^15 档建的库互不干扰（存量库不受本次改动影响）
import { describe, it, expect, afterAll } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deriveKeySync, KDF_CURRENT, KDF_LEGACY } from '../src/main/crypto/index'

// 真库文件一律放工作区 gitignore 的 data/ 内，跑完即删
const TMP_DIR = join(process.cwd(), 'data', `tmp-kdf-db-${randomBytes(4).toString('hex')}`)
mkdirSync(TMP_DIR, { recursive: true })

const PW = 'a-long-master-passphrase'
const salt = randomBytes(16)

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true })
})

/** 与应用 dbService.open() 相同的开库序列 */
function openDb(path: string, key: Buffer): Database.Database {
  const db = new Database(path)
  try {
    db.pragma('cipher = sqlcipher')
    db.pragma('legacy = 0')
    db.pragma(`key = "x'${key.toString('hex')}'"`)
    db.pragma('journal_mode = WAL')
  } catch (e) {
    // 应用里由调用方 close()；测试必须自己收，否则 Windows 删不掉临时文件
    db.close()
    throw e
  }
  return db
}

/**
 * 实测结论：错密钥在 SQLCipher 上是**开库阶段就抛**（journal_mode 那条 pragma 触发首读），
 * 不等调用方跑 SELECT —— 所以 master-password.ts 的逐档重试把 open 整个包在 try 里是对的。
 */
function tryOpen(path: string, key: Buffer): Database.Database | null {
  try {
    return openDb(path, key)
  } catch {
    return null
  }
}

function createDbAt(name: string, params: typeof KDF_LEGACY): string {
  const path = join(TMP_DIR, name)
  const db = openDb(path, deriveKeySync(PW, salt, params).key)
  db.prepare('CREATE TABLE t (v TEXT)').run()
  db.prepare('INSERT INTO t VALUES (?)').run('payload')
  db.close()
  return path
}

describe('档位与 SQLCipher 库的绑定关系', () => {
  it('2^17 档建的库：错档开不了、正档可开且数据完好', () => {
    const path = createDbAt('cur.db', KDF_CURRENT)
    expect(tryOpen(path, deriveKeySync(PW, salt, KDF_LEGACY).key)).toBeNull()
    const right = tryOpen(path, deriveKeySync(PW, salt, KDF_CURRENT).key)
    expect(right).not.toBeNull()
    expect((right!.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('payload')
    right!.close()
  })

  it('2^15 档建的库（存量库）仍可用原档打开，新档反而开不了', () => {
    const path = createDbAt('old.db', KDF_LEGACY)
    const db = tryOpen(path, deriveKeySync(PW, salt, KDF_LEGACY).key)
    expect(db).not.toBeNull()
    expect((db!.prepare('SELECT v FROM t').get() as { v: string }).v).toBe('payload')
    db!.close()
    expect(tryOpen(path, deriveKeySync(PW, salt, KDF_CURRENT).key)).toBeNull()
  })

  it('同一密码同一 salt，两档产出两个互不通用的库（不是「加强版可向下兼容」）', () => {
    const a = createDbAt('a.db', KDF_LEGACY)
    const b = createDbAt('b.db', KDF_CURRENT)
    expect(tryOpen(a, deriveKeySync(PW, salt, KDF_CURRENT).key)).toBeNull()
    expect(tryOpen(b, deriveKeySync(PW, salt, KDF_LEGACY).key)).toBeNull()
  })
})
