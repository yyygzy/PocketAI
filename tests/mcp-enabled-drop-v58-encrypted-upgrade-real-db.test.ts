// v58 真实升级路径 · 加密库版：v57（带 enabled 列）→ v58（删列），全程跑在 SQLite3MultipleCiphers
// 加密库上（页级 AES-256-GCM，文件头不是 "SQLite format 3"）。
//
// 为什么另起一份：普通 SQLite 上 DROP COLUMN 安全，不等于加密库上安全；产品真实库是加密库，
// 这里用测试口令（不是真实主密码）走 dbService.open(masterKey) 的同一 opening 路径。
//
// 造 v57 库：跑全链后 DELETE schema_migrations v58 + ADD COLUMN enabled 回来（MIGRATIONS 未导出，
// 无法原地停在 v57；v58 唯一作用就是删该列，还原列即等价 v57 schema）。
// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3-multiple-ciphers'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-v58-encrypted-upgrade'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { masterKeyManager } from '../src/main/crypto/master-key'
import { encryptSecretMap, isCipherText } from '../src/main/crypto/field-encrypt'

const VALUE_COLS = [
  'id',
  'name',
  'transport',
  'runtime',
  'command',
  'args',
  'env',
  'url',
  'created_at',
  'python_packages',
  'headers',
  'trust_read_only'
] as const

type Cell = string | number | null
type Row = Record<(typeof VALUE_COLS)[number], Cell>
type SeedRow = Row & { enabled: number }

/** 测试口令派生的库密钥；与产品一样只存在内存里，不写真实 key 文件 */
let DB_KEY: Buffer | null = null

function db(): Database.Database {
  return dbService.getHandle()
}

function colsOf(table: string): string[] {
  return (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  )
}

function selectRows(): Row[] {
  return db().prepare(`SELECT ${VALUE_COLS.join(', ')} FROM mcp_servers ORDER BY id`).all() as Row[]
}

function selectRowsWithEnabled(): SeedRow[] {
  return db()
    .prepare(`SELECT ${VALUE_COLS.join(', ')}, enabled FROM mcp_servers ORDER BY id`)
    .all() as SeedRow[]
}

function selectLogs(): Array<Record<string, Cell>> {
  return db().prepare('SELECT * FROM mcp_call_log ORDER BY id').all() as Array<Record<string, Cell>>
}

function integrity(): string[] {
  const rows = db().prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>
  return rows.map((r) => r.integrity_check)
}

function journalMode(): string {
  return db().pragma('journal_mode', { simple: true }) as string
}

function versionName(version: number): string | undefined {
  return (
    db().prepare('SELECT name FROM schema_migrations WHERE version=?').get(version) as
      | { name: string }
      | undefined
  )?.name
}

function valueOf(row: SeedRow | Row): Row {
  const out: Partial<Row> = {}
  for (const c of VALUE_COLS) out[c] = row[c]
  return out as Row
}

function seedRows(): SeedRow[] {
  return [
    {
      id: '00000000-0000-4000-8000-000000000101',
      name: 'off-stdio',
      transport: 'stdio',
      runtime: 'binary',
      command: 'npx',
      args: '["-y","enc-pkg","--x","a b"]',
      env: encryptSecretMap({ API_KEY: 'sk-enc-off-1' }),
      url: null,
      created_at: 1_700_000_100_001,
      python_packages: '[]',
      headers: null,
      trust_read_only: 0,
      enabled: 0
    },
    {
      id: '00000000-0000-4000-8000-000000000102',
      name: 'on-stdio',
      transport: 'stdio',
      runtime: 'python',
      command: 'python',
      args: '[]',
      env: encryptSecretMap({ TOKEN: 'tok-enc-on-2' }),
      url: null,
      created_at: 1_700_000_100_002,
      python_packages: '["requests"]',
      headers: null,
      trust_read_only: 1,
      enabled: 1
    },
    {
      id: '00000000-0000-4000-8000-000000000103',
      name: 'off-http',
      transport: 'http',
      runtime: 'binary',
      command: null,
      args: null,
      env: null,
      url: 'https://enc-off.example.com/mcp',
      created_at: 1_700_000_100_003,
      python_packages: '[]',
      headers: encryptSecretMap({ Authorization: 'Bearer enc-off-3' }),
      trust_read_only: 0,
      enabled: 0
    },
    {
      id: '00000000-0000-4000-8000-000000000104',
      name: 'on-http',
      transport: 'http',
      runtime: 'binary',
      command: null,
      args: null,
      env: encryptSecretMap({ QUERY_KEY: 'q-enc-on-4' }),
      url: 'https://enc-on.example.com/mcp',
      created_at: 1_700_000_100_004,
      python_packages: '[]',
      headers: encryptSecretMap({ 'X-Api-Key': 'k-enc-on-4' }),
      trust_read_only: 1,
      enabled: 1
    },
    {
      id: '00000000-0000-4000-8000-000000000105',
      name: 'MCP 加密旧服务（离线）',
      transport: 'stdio',
      runtime: 'binary',
      command: 'node',
      args: '["server.js"]',
      env: encryptSecretMap({ PASS: 'p-enc-off-5' }),
      url: null,
      created_at: 1_700_000_100_005,
      python_packages: '[]',
      headers: null,
      trust_read_only: 0,
      enabled: 0
    },
    {
      id: '00000000-0000-4000-8000-000000000106',
      name: '空凭据-on',
      transport: 'stdio',
      runtime: 'binary',
      command: 'uvx',
      args: '["tool"]',
      env: '',
      url: null,
      created_at: 1_700_000_100_006,
      python_packages: '[]',
      headers: null,
      trust_read_only: 1,
      enabled: 1
    }
  ]
}

let SEED: SeedRow[] = []

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  // 与产品 db 模式一致：先解锁派生库密钥/字段密钥，再以该密钥打开加密库
  masterKeyManager.init('db')
  DB_KEY = masterKeyManager.setKey('v58-encrypted-upgrade-test-pass')
  dbService.open(DB_KEY)
  dbService.runMigrations()
  SEED = seedRows()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 关不掉不掩盖结论 */
  }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch {
    /* scratch 残留由临时目录承担 */
  }
})

describe('v58 加密库升级（v57 带 enabled 列 → v58 删列）', () => {
  it('加密库 + v57 形状：文件头非明文、两组 enabled 都有行、密文可辨', () => {
    const head = fs.readFileSync(P.db).subarray(0, 16).toString('latin1')
    expect(head).not.toBe('SQLite format 3\u0000')
    expect(journalMode()).toBe('wal')

    db().exec('ALTER TABLE mcp_servers ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1')
    const insert = db().prepare(
      `INSERT INTO mcp_servers (${VALUE_COLS.join(', ')}, enabled)
       VALUES (${VALUE_COLS.map(() => '?').join(', ')}, ?)`
    )
    for (const r of SEED) insert.run(...VALUE_COLS.map((c) => r[c]), r.enabled)
    const log = db().prepare(
      `INSERT INTO mcp_call_log (server_id, tool, ok, duration_ms, args_preview, result_preview, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const sid of [SEED[2]!.id, SEED[4]!.id]) {
      log.run(sid, 'probe', 1, 42, '{"q":1}', '{"ok":true}', null, 1_700_000_101_000)
    }

    const rows = selectRowsWithEnabled()
    expect(rows).toHaveLength(6)
    expect(rows.filter((r) => r.enabled === 0)).toHaveLength(3)
    expect(rows.filter((r) => r.enabled === 1)).toHaveLength(3)
    let cipherCells = 0
    for (const r of rows) {
      for (const c of ['env', 'headers'] as const) {
        if (r[c]) {
          expect(isCipherText(r[c] as string), `${r.id}.${c} 应是字段密文`).toBe(true)
          cipherCells++
        }
      }
    }
    expect(cipherCells).toBeGreaterThan(0)
    expect(integrity()).toEqual(['ok'])
  })

  it('加密库上 DROP COLUMN 成功：行不丢不重、12 列与密文字节不变、两组只少一列', () => {
    const before = selectRowsWithEnabled()
    const beforeLogs = selectLogs()

    db().prepare('DELETE FROM schema_migrations WHERE version=58').run()
    expect(() => dbService.runMigrations()).not.toThrow()

    const after = selectRows()
    expect(after).toHaveLength(before.length)
    expect(new Set(after.map((r) => r.id)).size).toBe(after.length)
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id))

    const beforeById = new Map(before.map((r) => [r.id, r]))
    for (const now of after) {
      const old = beforeById.get(now.id)!
      expect(now, `行 ${now.id} 的 12 列被迁移改动`).toEqual(valueOf(old))
    }
    for (const flag of [0, 1]) {
      const group = before.filter((r) => r.enabled === flag)
      expect(group.length).toBeGreaterThan(0)
      for (const old of group) {
        expect(after.find((r) => r.id === old.id)!, `enabled=${flag}`).toEqual(valueOf(old))
      }
    }
    for (const old of before) {
      const now = after.find((r) => r.id === old.id)!
      expect(now.env, `${old.id}.env 密文字节变了`).toBe(old.env)
      expect(now.headers, `${old.id}.headers 密文字节变了`).toBe(old.headers)
    }

    expect(selectLogs()).toEqual(beforeLogs)
    expect(colsOf('mcp_servers')).not.toContain('enabled')
    expect(versionName(58)).toBe('drop_mcp_servers_enabled')
    expect(integrity()).toEqual(['ok'])
  })

  it('加密库上重复跑守卫同样生效：不抛、列仍不在、行不变', () => {
    const before = selectRows()
    db().prepare('DELETE FROM schema_migrations WHERE version=58').run()
    expect(() => dbService.runMigrations()).not.toThrow()
    expect(colsOf('mcp_servers')).not.toContain('enabled')
    expect(versionName(58)).toBe('drop_mcp_servers_enabled')
    expect(selectRows()).toEqual(before)
    expect(integrity()).toEqual(['ok'])
  })

  it('加密库 + WAL + DROP COLUMN：关库无 -wal/-shm 残留，重开完整', () => {
    expect(journalMode()).toBe('wal')
    const walSide = [P.db + '-wal', P.db + '-shm']
    // 迁移期间连接开着，侧文件允许存在；干净 close 之后必须被 SQLite 收走
    dbService.close()
    const residue = walSide
      .filter((f) => fs.existsSync(f))
      .map((f) => `${path.basename(f)}:${fs.statSync(f).size}b`)
    expect(residue, '关库后仍有 WAL 侧文件残留').toEqual([])

    // 干净关闭后做「重建连接」实证：正确 key 可读、无 key/错 key 打不开
    expect(DB_KEY).not.toBeNull()
    expect(masterKeyManager.getDbKey()!.equals(DB_KEY!)).toBe(true)
    const keyHex = DB_KEY!.toString('hex')

    const right = new Database(P.db)
    right.pragma('cipher = sqlcipher')
    right.pragma('legacy = 0')
    right.pragma(`key = "x'${keyHex}'"`)
    const n = right.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get() as { n: number }
    expect(n.n).toBe(6)
    const cols = right.prepare('PRAGMA table_info(mcp_servers)').all() as Array<{ name: string }>
    expect(cols.map((c) => c.name)).not.toContain('enabled')
    expect(
      (right.prepare('PRAGMA integrity_check').all() as Array<{ integrity_check: string }>)[0]!
        .integrity_check
    ).toBe('ok')
    right.close()

    const none = new Database(P.db)
    none.pragma('cipher = sqlcipher')
    none.pragma('legacy = 0')
    expect(() => none.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get()).toThrow()
    none.close()

    const wrong = new Database(P.db)
    wrong.pragma('cipher = sqlcipher')
    wrong.pragma('legacy = 0')
    expect(() => {
      wrong.pragma(`key = "x'${Buffer.from('wrong-key-material').toString('hex')}'"`)
      wrong.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get()
    }).toThrow()
    wrong.close()

    dbService.open(DB_KEY!)
    expect(journalMode()).toBe('wal')
    expect(integrity()).toEqual(['ok'])
    expect(selectRows()).toHaveLength(6)
  })
})
