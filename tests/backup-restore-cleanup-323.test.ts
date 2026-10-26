// @vitest-environment node
// V4-Iter-323②③ 服务层：恢复收尾那两条不对称。
//
// ② `restoreBackupBlob` 的 finally 里那句 `rmSync` 原本裸着（同文件的姊妹 `createZipBuffer` 包着并留痕）：
//    清理一抛（Windows 上 EBUSY／EPERM 很常见），finally 的抛出会**顶掉上面已经备好的 return** ⇒
//    库已换、迁移已跑、日志写着「恢复完成」，而屏上回一句「本地恢复失败」。
// ③ 增量恢复那份从 `setRawKey` 之后就没有 try：下载抖动、附件写盘、关库、换库那一句任何一抛，
//    既不回滚会话密钥、也不把库重开 ⇒ 应用带着与磁盘不一致的密钥继续服务（全量那份写了这套，增量漏了）。
//
// 真的：backup-service 本体（含 sha256 校验、路径穿越拦截、journal 模式、密钥回滚链）、node:fs 的其余调用。
// 假的：SQLite（真库换文件在 CI 里既慢又不必）、master-key／webdav-client／unzipper／logger／portable 的边界。
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const H = vi.hoisted(() => ({
  rmThrows: false,
  rmCalls: 0,
  /** 命中该后缀的 writeFileSync 抛出（模拟被锁的盘／半截写入） */
  writeThrowsFor: null as string | null,
  keyWrites: [] as string[],
  dbKey: null as Uint8Array | null,
  openCalls: 0,
  closeCalls: 0,
  migrationCalls: 0,
  warns: [] as string[],
  errors: [] as string[],
  zipFiles: [] as { path: string }[],
  extractFiles: [] as { name: string; data: Uint8Array }[],
  index: null as Record<string, unknown> | null,
  blobs: new Map<string, Uint8Array>(),
  remoteThrows: false,
  /** 远端只有这一份索引，其余文件名一律报「没有这个文件」 */
  remoteName: 'pocketai-inc-2026-10-26T000000000000Z.json',
  /** 会话里原本那颗库密钥（回滚判据比的是同一颗对象） */
  PREV: Buffer.alloc(32, 7),
  reset() {
    this.rmThrows = false
    this.rmCalls = 0
    this.writeThrowsFor = null
    this.keyWrites = []
    this.dbKey = Buffer.alloc(32, 7)
    this.openCalls = 0
    this.closeCalls = 0
    this.migrationCalls = 0
    this.warns = []
    this.errors = []
    this.zipFiles = []
    this.extractFiles = []
    this.index = null
    this.blobs = new Map()
    this.remoteThrows = false
  }
}))

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    default: actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      H.rmCalls++
      if (H.rmThrows) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return actual.rmSync(...args)
    },
    writeFileSync: (p: never, ...rest: unknown[]) => {
      if (H.writeThrowsFor && String(p).endsWith(H.writeThrowsFor)) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, open '${String(p)}'`), { code: 'EBUSY' })
      }
      return (actual.writeFileSync as (...a: unknown[]) => void)(p, ...rest)
    }
  }
})

vi.mock('archiver', () => ({ default: () => ({}) }))

vi.mock('unzipper', async () => {
  const { Writable } = await vi.importActual<typeof import('node:stream')>('node:stream')
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
  const { join: j } = await vi.importActual<typeof import('node:path')>('node:path')
  return {
    default: {
      Open: {
        buffer: async () => ({ files: H.zipFiles })
      },
      // 真解压不做：条目内容直接摆进 tmp（tmp 目录由被测代码自己 mkdirSync 出来）
      Extract: (opts: { path: string }) => {
        for (const f of H.extractFiles) fs.writeFileSync(j(opts.path, f.name), f.data)
        const w = new Writable({ write(_c, _e, cb) { cb() } })
        w.on('finish', () => w.emit('close'))
        return w
      }
    }
  }
})

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({}),
    isOpen: () => true,
    close: () => {
      H.closeCalls++
    },
    open: () => {
      H.openCalls++
    },
    runMigrations: () => {
      H.migrationCalls++
    }
  }
}))

vi.mock('../src/main/portable', async () => {
  const os = await vi.importActual<typeof import('node:os')>('node:os')
  const { join: j } = await vi.importActual<typeof import('node:path')>('node:path')
  const root = j(os.tmpdir(), 'pocketai-323-svc')
  return { DATA_DIR: root, DB_PATH: j(root, 'app.db'), ATTACHMENTS_DIR: j(root, 'attachments') }
})

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getDbKey: () => H.dbKey,
    hasKey: () => Boolean(H.dbKey),
    isDbEncrypted: () => true,
    setRawKey: (k: Uint8Array) => {
      H.keyWrites.push(k === H.PREV ? '回滚到原会话密钥' : '切成备份库密钥')
      H.dbKey = k
    },
    setKey: (s: string) => {
      H.keyWrites.push(`setKey:${s}`)
      H.dbKey = null
    }
  }
}))

vi.mock('../src/main/crypto/field-encrypt', () => ({
  encryptApiKeys: (v: string) => v,
  decryptApiKeys: (v: string) => v,
  isCipherText: () => false
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {}, getMasterPasswordSalt: () => null },
  clearAppConfigCache: () => {}
}))

vi.mock('../src/main/backup/webdav-client', () => ({
  testConnection: async () => true,
  uploadBuffer: async () => ({}),
  downloadFile: async (_c: unknown, name: string) => {
    if (name !== H.remoteName) throw new Error(`远端没有这个文件：${name}`)
    return Buffer.from(JSON.stringify(H.index))
  },
  listFiles: async () => [],
  deleteFile: async () => {},
  remoteExists: async () => true,
  uploadRemoteBuffer: async () => ({}),
  downloadRemoteFile: async (_c: unknown, rel: string) => {
    // 只对附件生效：DB blob 那发在 setRawKey 之前，抛在那里属另一条链（本枚不收）
    if (H.remoteThrows && rel !== 'db.bin') throw new Error('网络抖动：连接被重置')
    const b = H.blobs.get(rel)
    if (!b) throw new Error(`索引指着一个不存在的 blob：${rel}`)
    return Buffer.from(b)
  }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...a: unknown[]) => H.warns.push(a.map(String).join(' ')),
    error: (...a: unknown[]) => H.errors.push(a.map(String).join(' '))
  })
}))

import { DB_PATH, ATTACHMENTS_DIR } from '../src/main/portable'
import { restoreBackupBlob, restoreIncrementalFromWebDAV } from '../src/main/backup/backup-service'

let realFs: typeof import('node:fs')
const cfg = {
  url: 'https://dav.example.com/d',
  directory: '/backups',
  username: 'u',
  passwordCipher: 'x'
} as never

const DB_BYTES = Buffer.from('这是备份库里的那份字节')
const ATT_BYTES = Buffer.from('附件一份')

function mkIndex(attachments: Array<{ name: string; blob: string }>): void {
  H.blobs.set('db.bin', DB_BYTES)
  for (const a of attachments) H.blobs.set(a.blob, ATT_BYTES)
  const withSha = attachments.map((a) => ({ ...a, sha256: sha(ATT_BYTES) }))
  H.index = {
    kind: 'pocketai-incremental',
    encrypted: false,
    dbEncrypted: false,
    db: { blob: 'db.bin', sha256: sha(DB_BYTES), size: DB_BYTES.length },
    attachments: withSha
  }
}

beforeAll(async () => {
  realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
  realFs.mkdirSync(ATTACHMENTS_DIR, { recursive: true })
})

// 「故意让清理抛」那两条会真的留下临时目录（判据要的就是这份残留），收尾自己扫干净——
// 这个前缀只有 restoreBackupBlob 在用（其余测试各用 pocketai-drag-test-／pocketai-local-restore-test-）
afterEach(() => {
  for (const d of realFs.readdirSync(tmpdir())) {
    if (d.startsWith('pocketai-restore-')) realFs.rmSync(join(tmpdir(), d), { recursive: true, force: true })
  }
})

beforeEach(() => {
  H.reset()
  H.dbKey = H.PREV
  // 每个用例从干净的磁盘状态开始（附件与主库都不留上一次的痕迹）
  for (const f of realFs.readdirSync(ATTACHMENTS_DIR)) realFs.rmSync(join(ATTACHMENTS_DIR, f), { force: true })
  if (realFs.existsSync(DB_PATH)) realFs.rmSync(DB_PATH)
})

describe('§323② 全量恢复的收尾清理：失败只留痕，不许顶掉已经做成的结果', () => {
  const plainZip = Buffer.from('PK\x03\x04-不真的是 zip，明文路径不尝试解密')

  it('清理抛了 ⇒ 结果仍是 {ok:true}（库已换、迁移已跑），并留一条 warn 说残留在哪', async () => {
    H.zipFiles = [{ path: 'app.db' }, { path: 'manifest.json' }]
    H.extractFiles = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ dbEncrypted: false })) },
      { name: 'app.db', data: DB_BYTES }
    ]
    H.rmThrows = true
    const r = await restoreBackupBlob(plainZip, false, { displayName: 'b.zip' })
    expect(r.ok, '清理失败不该把已完成的整库替换报成失败（那会诱导用户再恢复一次）').toBe(true)
    expect(H.migrationCalls).toBe(1)
    expect(H.warns.filter((w) => w.includes('恢复临时目录清理失败'))).toHaveLength(1)
    expect(H.warns[0]).toContain('EBUSY')
    expect(H.rmCalls, '清理这一步本身照样要试过（不是改成不清理）').toBe(1)
  })

  it('反向对照：清理顺利 ⇒ 零 warn 且临时目录真的没了（兜底不是常开的挡箭牌）', async () => {
    H.zipFiles = [{ path: 'app.db' }, { path: 'manifest.json' }]
    H.extractFiles = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify({ dbEncrypted: false })) },
      { name: 'app.db', data: DB_BYTES }
    ]
    const r = await restoreBackupBlob(plainZip, false, {})
    expect(r.ok).toBe(true)
    expect(H.warns).toEqual([])
    // 临时目录名带时间戳，判「真的清掉了」只能按这一层：rmSync 成功调过一次＋一句 warn 都没有
    expect(H.rmCalls).toBe(1)
  })

  it('中途失败（备份包缺 manifest）⇒ 清理抛了也不许改写那句失败原因', async () => {
    H.zipFiles = [{ path: 'manifest.json' }]
    H.extractFiles = []
    H.rmThrows = true
    const r = await restoreBackupBlob(plainZip, false, {})
    expect(r.error).toContain('缺少 manifest.json')
    expect(H.warns.filter((w) => w.includes('恢复临时目录清理失败'))).toHaveLength(1)
  })
})

describe('§323③ 增量恢复：setRawKey 之后任何一抛都要把会话密钥换回去、库要开着', () => {
  it('换库那一句写失败 ⇒ 回滚原会话密钥＋重开库，结果是一句「增量恢复失败：原文」', async () => {
    mkIndex([])
    H.writeThrowsFor = 'app.db'
    const r = await restoreIncrementalFromWebDAV(cfg, H.remoteName)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('增量恢复失败：')
    expect(r.error).toContain('EBUSY')
    expect(H.keyWrites, '磁盘仍是原库 ⇒ 内存里那份备份库密钥必须换回去').toEqual(['回滚到原会话密钥'])
    expect(H.closeCalls).toBe(1)
    expect(H.openCalls, '库是关着抛出的，收尾必须重开').toBe(1)
    expect(H.migrationCalls, '没换库就不该跑迁移').toBe(0)
    expect(H.errors.filter((e) => e.includes('增量恢复中途失败'))).toHaveLength(1)
  })

  it('抛出发生在关库之前（附件写盘被锁）⇒ 一样要回滚密钥；重开那句是幂等的（database.ts:876）', async () => {
    mkIndex([{ name: 'a1.bin', blob: 'a1.bin' }])
    H.writeThrowsFor = 'a1.bin'
    const r = await restoreIncrementalFromWebDAV(cfg, H.remoteName)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('增量恢复失败：')
    expect(H.keyWrites).toEqual(['回滚到原会话密钥'])
    expect(H.closeCalls, '这一步库根本还没关').toBe(0)
    expect(H.openCalls).toBe(1)
  })

  it('下载抖动抛出 ⇒ 同样收口（这一处原本连错误句都没有，直接逃到 IPC 边界）', async () => {
    mkIndex([{ name: 'a1.bin', blob: 'a1.bin' }])
    H.remoteThrows = true
    const r = await restoreIncrementalFromWebDAV(cfg, H.remoteName)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('网络抖动')
    expect(H.keyWrites).toEqual(['回滚到原会话密钥'])
    expect(H.openCalls).toBe(1)
  })

  it('反向对照：全程顺利 ⇒ {ok:true}，一次密钥都不许动、迁移照常跑', async () => {
    mkIndex([])
    const r = await restoreIncrementalFromWebDAV(cfg, H.remoteName)
    expect(r.ok).toBe(true)
    expect(H.keyWrites).toEqual([])
    expect(H.closeCalls).toBe(1)
    expect(H.openCalls).toBe(1)
    expect(H.migrationCalls).toBe(1)
    expect(H.errors).toEqual([])
    expect(realFs.readFileSync(DB_PATH)).toEqual(DB_BYTES)
  })

  it('反向对照：索引里写着非法附件名 ⇒ 走的是原来那句拒绝，不许被新的 catch 洗成「增量恢复失败：」', async () => {
    mkIndex([{ name: '../ escapes', blob: 'x.bin' }])
    const r = await restoreIncrementalFromWebDAV(cfg, H.remoteName)
    expect(r.error).toContain('非法的附件名')
    expect(r.error).not.toContain('增量恢复失败：')
    expect(H.keyWrites).toEqual(['回滚到原会话密钥'])
    expect(H.openCalls, '早退那几条本来就带着 restoreSessionKey，不该多出一次重开').toBe(0)
  })
})
