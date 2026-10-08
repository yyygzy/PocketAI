// merge-service 双向合并测试
//
// 覆盖 src/main/backup/merge-service.ts 核心合并逻辑：
// - scanTableConflicts：cloudOnly / localOnly / both 冲突统计
// - mergeTable：行级合并（插入云端新增 / 冲突按策略取舍 / 相同跳过）
// - overwriteTable：配置类表云端覆盖
//
// 策略：用 better-sqlite3-multiple-ciphers 内存数据库构造本地/云端两份数据，
// 直接调用导出的纯函数验证结果。mock 掉 electron / dbService / masterKeyManager
// / webdav-client 等非测试目标依赖，避免原生模块加载链断裂。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

// mock electron（portable.ts 依赖）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// mock dbService（合并纯函数不需要真实 dbService，但模块加载时会导入）
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))

// mock masterKeyManager
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getDbKey: () => null, isDbEncrypted: () => false }
}))

// mock webdav-client
vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: vi.fn(),
  downloadRemoteFile: vi.fn()
}))

// mock backup-service 中 merge-service 不需要的部分（但需保留类型导出与安全收口函数）
vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PKBK1',
  isEncryptedBlob: (_buf: Buffer, name: string) => name.endsWith('.enc'),
  decryptBackup: vi.fn(),
  toCreds: (cfg: unknown) => cfg,
  isSafeZipEntryName: (rawName: string) => {
    const name = String(rawName ?? '').replace(/\\/g, '/')
    return !!name && !name.startsWith('/') && !/^[a-zA-Z]:/.test(name) && !name.split('/').includes('..')
  },
  containsSymlink: () => false
}))

import {
  scanTableConflicts,
  mergeTable,
  overwriteTable,
  parseIncrementalIndex
} from '../src/main/backup/merge-service'

// 测试用表结构（模拟 conversations）
const SCHEMA = `
  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    updated_at INTEGER NOT NULL
  );
`

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function insertConv(db: Database.Database, id: string, title: string, updatedAt: number) {
  db.prepare('INSERT INTO conversations (id, title, updated_at) VALUES (?, ?, ?)').run(id, title, updatedAt)
}

function getConv(db: Database.Database, id: string): { id: string; title: string; updated_at: number } | undefined {
  return db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as
    | { id: string; title: string; updated_at: number }
    | undefined
}

describe('scanTableConflicts', () => {
  let local: Database.Database
  let cloud: Database.Database

  beforeEach(() => {
    local = createDb()
    cloud = createDb()
  })

  it('云端独有 → cloudOnly 计数', () => {
    insertConv(local, 'L1', 'local-only', 100)
    insertConv(cloud, 'C1', 'cloud-only', 200)
    const r = scanTableConflicts(local, cloud, 'conversations', 'updated_at')
    expect(r.cloudOnly).toBe(1)
    expect(r.localOnly).toBe(1)
    expect(r.both).toBe(0)
  })

  it('两边都有但内容不同 → both 计数', () => {
    insertConv(local, 'X', 'local-title', 100)
    insertConv(cloud, 'X', 'cloud-title', 200)
    const r = scanTableConflicts(local, cloud, 'conversations', 'updated_at')
    expect(r.cloudOnly).toBe(0)
    expect(r.localOnly).toBe(0)
    expect(r.both).toBe(1)
  })

  it('两边都有且内容相同 → 不计入冲突', () => {
    insertConv(local, 'X', 'same', 100)
    insertConv(cloud, 'X', 'same', 100)
    const r = scanTableConflicts(local, cloud, 'conversations', 'updated_at')
    expect(r.cloudOnly).toBe(0)
    expect(r.localOnly).toBe(0)
    expect(r.both).toBe(0)
  })

  it('云端不存在该表 → 全零', () => {
    insertConv(local, 'L1', 'local', 100)
    const r = scanTableConflicts(local, cloud, 'nonexistent_table', null)
    expect(r.cloudOnly).toBe(0)
    expect(r.localOnly).toBe(0)
    expect(r.both).toBe(0)
  })
})

describe('mergeTable', () => {
  let local: Database.Database
  let cloud: Database.Database

  beforeEach(() => {
    local = createDb()
    cloud = createDb()
  })

  it('云端独有的行被插入本地', () => {
    insertConv(local, 'L1', 'local', 100)
    insertConv(cloud, 'C1', 'cloud-new', 200)
    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'cloud')
    expect(r.inserted).toBe(1)
    expect(getConv(local, 'C1')?.title).toBe('cloud-new')
  })

  it('本地独有的行保留不动', () => {
    insertConv(local, 'L1', 'local-only', 100)
    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'cloud')
    expect(r.inserted).toBe(0)
    expect(getConv(local, 'L1')?.title).toBe('local-only')
  })

  it('冲突时 cloud 策略 → 取云端版本', () => {
    insertConv(local, 'X', 'local-title', 100)
    insertConv(cloud, 'X', 'cloud-title', 200)
    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'cloud')
    expect(r.updated).toBe(1)
    expect(getConv(local, 'X')?.title).toBe('cloud-title')
  })

  it('冲突时 local 策略 → 保留本地版本', () => {
    insertConv(local, 'X', 'local-title', 100)
    insertConv(cloud, 'X', 'cloud-title', 200)
    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'local')
    expect(r.updated).toBe(0)
    expect(r.skipped).toBe(1)
    expect(getConv(local, 'X')?.title).toBe('local-title')
  })

  it('冲突时 newer 策略 → 取时间戳较新的', () => {
    insertConv(local, 'X', 'local-old', 100)
    insertConv(cloud, 'X', 'cloud-newer', 200)
    mergeTable(local, cloud, 'conversations', 'updated_at', 'newer')
    expect(getConv(local, 'X')?.title).toBe('cloud-newer')

    // 反过来：本地较新
    insertConv(local, 'Y', 'local-newer', 300)
    insertConv(cloud, 'Y', 'cloud-old', 100)
    mergeTable(local, cloud, 'conversations', 'updated_at', 'newer')
    expect(getConv(local, 'Y')?.title).toBe('local-newer')
  })

  it('内容相同的行跳过（不更新）', () => {
    insertConv(local, 'X', 'same', 100)
    insertConv(cloud, 'X', 'same', 100)
    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'cloud')
    expect(r.skipped).toBe(1)
    expect(r.updated).toBe(0)
  })

  it('云端没有该表 → 无变化', () => {
    insertConv(local, 'L1', 'local', 100)
    const r = mergeTable(local, cloud, 'nonexistent', 'updated_at', 'cloud')
    expect(r.inserted).toBe(0)
    expect(r.updated).toBe(0)
  })
})

describe('overwriteTable', () => {
  it('清空本地并导入云端全部行', () => {
    const local = createDb()
    const cloud = createDb()
    insertConv(local, 'L1', 'to-be-cleared', 100)
    insertConv(cloud, 'C1', 'cloud-1', 200)
    insertConv(cloud, 'C2', 'cloud-2', 300)

    const n = overwriteTable(local, cloud, 'conversations')
    expect(n).toBe(2)
    expect(getConv(local, 'L1')).toBeUndefined()
    expect(getConv(local, 'C1')?.title).toBe('cloud-1')
    expect(getConv(local, 'C2')?.title).toBe('cloud-2')
  })

  it('云端没有该表 → 返回 0，本地不变', () => {
    const local = createDb()
    const cloud = createDb()
    insertConv(local, 'L1', 'keep', 100)
    const n = overwriteTable(local, cloud, 'nonexistent')
    expect(n).toBe(0)
    expect(getConv(local, 'L1')?.title).toBe('keep')
  })
})

// SEC-30：配置表的凭据列是字段密文，跨机合并时云那份用源机主密钥加密、本机解不开。
// overwriteTable 的 preserveColumns 让本机已有行的凭据列保持本机值，其余列照旧云端覆盖。
const PROVIDER_SCHEMA = `
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT,
    api_key_encrypted TEXT
  );
`
const MCP_SCHEMA = `
  CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT,
    env TEXT,
    headers TEXT
  );
`

function createSchemaDb(schema: string): Database.Database {
  const db = new Database(':memory:')
  db.exec(schema)
  return db
}

function insertProvider(db: Database.Database, id: string, name: string, keyCipher: string) {
  db.prepare('INSERT INTO providers (id, name, api_key_encrypted) VALUES (?, ?, ?)').run(id, name, keyCipher)
}

function getProvider(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM providers WHERE id=?').get(id) as Record<string, unknown> | undefined
}

function insertMcp(db: Database.Database, id: string, name: string, env: string, headers: string) {
  db.prepare('INSERT INTO mcp_servers (id, name, env, headers) VALUES (?, ?, ?, ?)').run(id, name, env, headers)
}

function getMcp(db: Database.Database, id: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM mcp_servers WHERE id=?').get(id) as Record<string, unknown> | undefined
}

describe('overwriteTable 凭据列保留（SEC-30）', () => {
  it('同 id 行：非凭据列取云端，凭据列保留本机密文', () => {
    const local = createSchemaDb(PROVIDER_SCHEMA)
    const cloud = createSchemaDb(PROVIDER_SCHEMA)
    insertProvider(local, 'P1', 'local-name', 'v1:LOCAL-KEY')
    insertProvider(cloud, 'P1', 'cloud-name', 'v1:OTHER-MACHINE-KEY')

    const n = overwriteTable(local, cloud, 'providers', { preserveColumns: ['api_key_encrypted'] })
    expect(n).toBe(1)
    const row = getProvider(local, 'P1')
    expect(row?.name).toBe('cloud-name')
    expect(row?.api_key_encrypted).toBe('v1:LOCAL-KEY')
  })

  it('云端独有行：没有本机值可留 → 沿用云端凭据（同机合并仍可用）', () => {
    const local = createSchemaDb(PROVIDER_SCHEMA)
    const cloud = createSchemaDb(PROVIDER_SCHEMA)
    insertProvider(cloud, 'P2', 'cloud-only', 'v1:CLOUD-KEY')

    overwriteTable(local, cloud, 'providers', { preserveColumns: ['api_key_encrypted'] })
    expect(getProvider(local, 'P2')?.api_key_encrypted).toBe('v1:CLOUD-KEY')
  })

  it('多凭据列（mcp_servers 的 env + headers）一起保留', () => {
    const local = createSchemaDb(MCP_SCHEMA)
    const cloud = createSchemaDb(MCP_SCHEMA)
    insertMcp(local, 'M1', 'local-title', 'v1:LOCAL-ENV', 'v1:LOCAL-HEADERS')
    insertMcp(cloud, 'M1', 'cloud-title', 'v1:CLOUD-ENV', 'v1:CLOUD-HEADERS')
    insertMcp(cloud, 'M2', 'cloud-new', 'v1:CLOUD-ENV2', 'v1:CLOUD-HEADERS2')

    const n = overwriteTable(local, cloud, 'mcp_servers', { preserveColumns: ['env', 'headers'] })
    expect(n).toBe(2)
    expect(getMcp(local, 'M1')).toMatchObject({ name: 'cloud-title', env: 'v1:LOCAL-ENV', headers: 'v1:LOCAL-HEADERS' })
    expect(getMcp(local, 'M2')).toMatchObject({ env: 'v1:CLOUD-ENV2', headers: 'v1:CLOUD-HEADERS2' })
  })

  it('不传 preserveColumns → 凭据列照旧被云端覆盖（回归保护）', () => {
    const local = createSchemaDb(PROVIDER_SCHEMA)
    const cloud = createSchemaDb(PROVIDER_SCHEMA)
    insertProvider(local, 'P1', 'local-name', 'v1:LOCAL-KEY')
    insertProvider(cloud, 'P1', 'cloud-name', 'v1:CLOUD-KEY')

    overwriteTable(local, cloud, 'providers')
    expect(getProvider(local, 'P1')?.api_key_encrypted).toBe('v1:CLOUD-KEY')
  })

  it('云端库没有该凭据列（旧备份）→ 保留集为空，覆盖正常完成', () => {
    const local = createSchemaDb(PROVIDER_SCHEMA)
    const cloud = new Database(':memory:')
    cloud.exec('CREATE TABLE providers (id TEXT PRIMARY KEY, name TEXT)')
    cloud.prepare('INSERT INTO providers (id, name) VALUES (?, ?)').run('P1', 'cloud-name')
    insertProvider(local, 'P1', 'local-name', 'v1:LOCAL-KEY')

    const n = overwriteTable(local, cloud, 'providers', { preserveColumns: ['api_key_encrypted'] })
    expect(n).toBe(1)
    expect(getProvider(local, 'P1')?.name).toBe('cloud-name')
  })
})

describe('恶意备份库列名收口（SQL 注入防御）', () => {
  it('mergeTable：云端表含注入型畸形列名 → 按本地白名单过滤后正常合并', () => {
    const local = createDb()
    const cloud = createDb()
    // SQLite 允许带引号的畸形列名；旧逻辑会把它原样拼进 INSERT 导致语法破坏/注入
    cloud.exec('ALTER TABLE conversations ADD COLUMN "bad""col--" TEXT')
    insertConv(cloud, 'C1', 'cloud-new', 200)

    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'cloud')
    expect(r.inserted).toBe(1)
    expect(getConv(local, 'C1')?.title).toBe('cloud-new')
  })

  it('overwriteTable：云端表含畸形列名 → 过滤后正常覆盖', () => {
    const local = createDb()
    const cloud = createDb()
    cloud.exec('ALTER TABLE conversations ADD COLUMN "x) VALUES(1);--" TEXT')
    insertConv(local, 'L1', 'to-be-cleared', 100)
    insertConv(cloud, 'C1', 'cloud-1', 200)

    const n = overwriteTable(local, cloud, 'conversations')
    expect(n).toBe(1)
    expect(getConv(local, 'L1')).toBeUndefined()
    expect(getConv(local, 'C1')?.title).toBe('cloud-1')
  })

  it('云端列与本地只剩 id 交集（畸形/残表）→ 整表跳过，不生成空 UPDATE', () => {
    const local = createDb()
    insertConv(local, 'L1', 'keep-local', 100)
    const cloud = new Database(':memory:')
    cloud.exec('CREATE TABLE conversations (id TEXT PRIMARY KEY, only_cloud_col TEXT)')
    cloud.prepare('INSERT INTO conversations VALUES (?, ?)').run('C1', 'x')
    const r = mergeTable(local, cloud, 'conversations', 'updated_at', 'cloud')
    expect(r.inserted).toBe(0)
    expect(getConv(local, 'L1')?.title).toBe('keep-local')

    // overwriteTable 同样必须跳过（不能先清空本地再写残行）
    expect(overwriteTable(local, cloud, 'conversations')).toBe(0)
    expect(getConv(local, 'L1')?.title).toBe('keep-local')
  })
})

describe('parseIncrementalIndex 增量索引校验', () => {
  const validIndex = {
    kind: 'pocketai-incremental',
    version: 1,
    createdAt: '2026-09-27T00:00:00.000Z',
    encrypted: false,
    dbEncrypted: false,
    db: { blob: 'blobs/db-abc.bin', sha256: 'A'.repeat(64), size: 128 },
    attachments: [
      { name: 'att-1.png', sha256: 'B'.repeat(64), size: 10, blob: 'blobs/att-bbb.bin' }
    ]
  }

  const enc = (obj: unknown): Buffer => Buffer.from(JSON.stringify(obj), 'utf8')

  it('合法索引通过，sha256 统一转小写', () => {
    const idx = parseIncrementalIndex(enc(validIndex))
    expect(idx.kind).toBe('pocketai-incremental')
    expect(idx.db.sha256).toBe('a'.repeat(64))
    expect(idx.attachments[0]!.sha256).toBe('b'.repeat(64))
  })

  it('非 JSON → 拒绝', () => {
    expect(() => parseIncrementalIndex(Buffer.from('not-json{'))).toThrow(/不是有效 JSON/)
  })

  it('kind 错误 → 拒绝', () => {
    expect(() => parseIncrementalIndex(enc({ ...validIndex, kind: 'other' }))).toThrow(/不是有效的增量备份索引/)
  })

  it('db.sha256 非 64 位十六进制 → 拒绝', () => {
    const bad = { ...validIndex, db: { ...validIndex.db, sha256: 'xyz' } }
    expect(() => parseIncrementalIndex(enc(bad))).toThrow(/db 字段非法/)
  })

  it('db.blob 缺失 → 拒绝', () => {
    const bad = { ...validIndex, db: { sha256: 'a'.repeat(64) } }
    expect(() => parseIncrementalIndex(enc(bad))).toThrow(/db 字段非法/)
  })

  it('attachments 不是数组 → 拒绝', () => {
    const bad = { ...validIndex, attachments: 'nope' }
    expect(() => parseIncrementalIndex(enc(bad))).toThrow(/attachments 格式非法/)
  })

  it('附件条目缺字段 → 拒绝', () => {
    const bad = { ...validIndex, attachments: [{ name: 'x', sha256: 'a'.repeat(64) }] }
    expect(() => parseIncrementalIndex(enc(bad))).toThrow(/字段缺失/)
  })

  it('附件 sha256 非法 → 拒绝', () => {
    const bad = {
      ...validIndex,
      attachments: [{ name: 'x', sha256: 'ZZ', blob: 'blobs/x.bin' }]
    }
    expect(() => parseIncrementalIndex(enc(bad))).toThrow(/sha256 非法/)
  })

  it('附件数超上限 → 拒绝', () => {
    const bad = {
      ...validIndex,
      attachments: Array.from({ length: 10001 }, () => ({
        name: 'x', sha256: 'a'.repeat(64), blob: 'blobs/x.bin'
      }))
    }
    expect(() => parseIncrementalIndex(enc(bad))).toThrow(/超过上限 10000/)
  })

  it('attachments 缺省 → 按空数组通过', () => {
    const { attachments: _omit, ...minimal } = validIndex
    const idx = parseIncrementalIndex(enc(minimal))
    expect(idx.attachments).toEqual([])
  })
})
