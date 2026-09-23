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

// mock backup-service 中 merge-service 不需要的部分（但需保留类型导出）
vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PKBK1',
  isEncryptedBlob: (_buf: Buffer, name: string) => name.endsWith('.enc'),
  decryptBackup: vi.fn(),
  toCreds: (cfg: unknown) => cfg
}))

import { scanTableConflicts, mergeTable, overwriteTable } from '../src/main/backup/merge-service'

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
