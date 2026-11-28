// SEC-16-10 备份合并知识库一致性测试
//
// 修复前的缺陷：kb_documents/kb_chunks/knowledge_bases 在 CLOUD_OVERWRITE_TABLES 里整表
// DELETE+覆盖 —— (a) 本地独有文档丢失；(b) kb_vec_map 不在清单内，覆盖后 chunk 表与向量
// 映射错位（检索命中错位/漏召回）；(c) foreign_keys=ON 下 DELETE FROM knowledge_bases 还
// 会经 ON DELETE CASCADE 级联清空 kb_documents/kb_chunks。
//
// 修复后：三张 kb 表走行级合并（runDbMergeTx），合并事务末尾 reconcileKbVecAfterMerge
// 收口向量一致性（删失配/孤儿映射，统计需重建文档）。云端库的 vec 行不可搬运
// （vec_rowid 只对云端自己的 kb_vec_<dim> 虚表有意义），所以本地断言聚焦：
// 「kb_vec_map 与 kb_chunks 的行集合一致（孤儿=0）+ 不伪造云端向量」。
//
// 用真实临时 SQLite（:memory:）库直调导出的合并函数，mock 掉 electron/dbService 等非测试
// 目标依赖（同 tests/merge-service.test.ts 的形状）。sqlite-vec 装得上的话再补一个真实
// vec0 虚表用例，验证 vec 行也跟着映射一起清理。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { createRequire } from 'node:module'

// mock electron（portable.ts 依赖）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// mock dbService（合并纯函数直接接收 db 句柄，但模块加载时会导入）
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => ({ prepare: () => ({ all: () => [], get: () => undefined, run: () => {} }) }) }
}))

// mock masterKeyManager
vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: { getDbKey: () => null, isDbEncrypted: () => false }
}))

vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: vi.fn(),
  downloadRemoteFile: vi.fn()
}))

vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PKBK1',
  isEncryptedBlob: () => false,
  decryptBackup: vi.fn(),
  deriveBackupDbKey: vi.fn(),
  toCreds: (cfg: unknown) => cfg,
  isSafeZipEntryName: () => true,
  containsSymlink: () => false,
  BackupDecryptError: class extends Error {}
}))

import { runDbMergeTx, reconcileKbVecAfterMerge } from '../src/main/backup/merge-service'

// kb 三表 + providers（凭据回归）+ kb_vec_map（向量映射）。其余 ROW_MERGE_TABLES 不建：
// mergeTable 以云端表存在性为闸，云端没有就整表跳过，不需要陪跑。
const SCHEMA = `
  CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY,
    name TEXT,
    embedding_dim INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE kb_documents (
    id TEXT PRIMARY KEY,
    kb_id TEXT NOT NULL,
    title TEXT,
    status TEXT NOT NULL DEFAULT 'ready',
    updated_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE kb_chunks (
    id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL,
    kb_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    content TEXT NOT NULL,
    embedding BLOB,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE kb_vec_map (
    chunk_id TEXT PRIMARY KEY,
    vec_rowid INTEGER NOT NULL,
    dim INTEGER NOT NULL
  );
  CREATE TABLE providers (
    id TEXT PRIMARY KEY,
    name TEXT,
    api_key_encrypted TEXT
  );
`

function createDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(SCHEMA)
  return db
}

function insertKb(db: Database.Database, id: string, name: string, createdAt = 100) {
  db.prepare('INSERT INTO knowledge_bases (id, name, created_at) VALUES (?, ?, ?)').run(id, name, createdAt)
}
function insertDoc(db: Database.Database, id: string, kbId: string, title: string, createdAt = 100, updatedAt: number | null = null) {
  db.prepare('INSERT INTO kb_documents (id, kb_id, title, updated_at, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, kbId, title, updatedAt, createdAt)
}
function insertChunk(db: Database.Database, id: string, docId: string, kbId: string, content: string, createdAt = 100, embedding: Buffer | null = null) {
  db.prepare('INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)')
    .run(id, docId, kbId, content, embedding, createdAt)
}
function insertMap(db: Database.Database, chunkId: string, vecRowid: number, dim = 4) {
  db.prepare('INSERT INTO kb_vec_map (chunk_id, vec_rowid, dim) VALUES (?, ?, ?)').run(chunkId, vecRowid, dim)
}
function insertProvider(db: Database.Database, id: string, name: string, keyCipher: string) {
  db.prepare('INSERT INTO providers (id, name, api_key_encrypted) VALUES (?, ?, ?)').run(id, name, keyCipher)
}

/** kb_vec_map 孤儿数：chunk 已不存在的映射行（验收口径：合并后必须为 0） */
function orphanMapCount(db: Database.Database): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM kb_vec_map m
       LEFT JOIN kb_chunks c ON c.id = m.chunk_id WHERE c.id IS NULL`
    )
    .get() as { n: number }
  return Number(row.n)
}

function docIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM kb_documents').all() as Array<{ id: string }>).map((r) => r.id)
}
function chunkIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM kb_chunks').all() as Array<{ id: string }>).map((r) => r.id)
}
function chunkContent(db: Database.Database, id: string): string | undefined {
  return (db.prepare('SELECT content FROM kb_chunks WHERE id=?').get(id) as { content: string } | undefined)?.content
}
function docTitle(db: Database.Database, id: string): string | undefined {
  return (db.prepare('SELECT title FROM kb_documents WHERE id=?').get(id) as { title: string } | undefined)?.title
}

describe('SEC-16-10 · kb 三表行级合并', () => {
  let local: Database.Database
  let cloud: Database.Database

  beforeEach(() => {
    local = createDb()
    cloud = createDb()
  })

  it('本地独有文档/分块在合并后仍在；云端新增行被合入（原整表覆盖会全丢）', () => {
    insertKb(local, 'kb-L', '本地库')
    insertDoc(local, 'd-L', 'kb-L', '本地独有文档')
    insertChunk(local, 'c-L1', 'd-L', 'kb-L', '本地分块')

    insertKb(cloud, 'kb-C', '云端库')
    insertDoc(cloud, 'd-C', 'kb-C', '云端新增文档')
    insertChunk(cloud, 'c-C1', 'd-C', 'kb-C', '云端分块1')
    insertChunk(cloud, 'c-C2', 'd-C', 'kb-C', '云端分块2')

    const parts = runDbMergeTx(local, cloud, 'cloud')

    expect(docIds(local).sort()).toEqual(['d-C', 'd-L'])
    expect(chunkIds(local).sort()).toEqual(['c-C1', 'c-C2', 'c-L1'])
    expect(chunkContent(local, 'c-L1')).toBe('本地分块')
    // UI 统计能看到 kb 表的合并行数（原走覆盖清单时只有「N 行(云端)」）
    expect(parts).toContain('kb_documents: +1 ~0')
    expect(parts).toContain('kb_chunks: +2 ~0')
    expect(parts).toContain('knowledge_bases: +1 ~0')
  })

  it('knowledge_bases 不再整表覆盖：云端覆盖不级联清空本地文档（FK ON DELETE CASCADE）', () => {
    // 修复前：覆盖清单 DELETE FROM knowledge_bases 会级联清空 kb_documents/kb_chunks，
    // 即使 kb_documents/kb_chunks 改成行合并也保不住——所以 kb 表必须三张一起走行合并。
    insertKb(local, 'kb-L', '本地库')
    insertDoc(local, 'd-L', 'kb-L', '本地文档')
    insertChunk(local, 'c-L1', 'd-L', 'kb-L', '本地分块')
    insertKb(cloud, 'kb-C', '云端库')

    runDbMergeTx(local, cloud, 'cloud')

    const kbIds = (local.prepare('SELECT id FROM knowledge_bases').all() as Array<{ id: string }>).map((r) => r.id)
    expect(kbIds.sort()).toEqual(['kb-C', 'kb-L'])
    expect(docIds(local)).toEqual(['d-L'])
    expect(chunkIds(local)).toEqual(['c-L1'])
  })

  it('同 id 冲突按 strategy 处理（cloud 取云端 / local 保本地 / newer 按时间戳）', () => {
    // cloud：文档与分块都被云端版本改写
    insertDoc(local, 'd1', 'kb', '本地标题', 100, 100)
    insertChunk(local, 'c1', 'd1', 'kb', '本地分块内容', 100)
    insertDoc(cloud, 'd1', 'kb', '云端标题', 100, 200)
    insertChunk(cloud, 'c1', 'd1', 'kb', '云端分块内容', 200)
    runDbMergeTx(local, cloud, 'cloud')
    expect(docTitle(local, 'd1')).toBe('云端标题')
    expect(chunkContent(local, 'c1')).toBe('云端分块内容')

    // local：同 id 冲突保留本地
    const l2 = createDb()
    const c2 = createDb()
    insertDoc(l2, 'd1', 'kb', '本地标题', 100, 300)
    insertDoc(c2, 'd1', 'kb', '云端标题', 100, 100)
    runDbMergeTx(l2, c2, 'local')
    expect(docTitle(l2, 'd1')).toBe('本地标题')

    // newer：kb_documents 按 updated_at 比较
    const l3 = createDb()
    const c3 = createDb()
    insertDoc(l3, 'd1', 'kb', '本地旧', 100, 100)
    insertDoc(c3, 'd1', 'kb', '云端新', 100, 200)
    insertDoc(l3, 'd2', 'kb', '本地新', 100, 300)
    insertDoc(c3, 'd2', 'kb', '云端旧', 100, 100)
    runDbMergeTx(l3, c3, 'newer')
    expect(docTitle(l3, 'd1')).toBe('云端新')
    expect(docTitle(l3, 'd2')).toBe('本地新')
  })
})

describe('SEC-16-10 · 合并后 kb_vec_map 与 kb_chunks 一致性', () => {
  let local: Database.Database
  let cloud: Database.Database

  beforeEach(() => {
    local = createDb()
    cloud = createDb()
    insertKb(local, 'kb', '库')
    insertDoc(local, 'd-L', 'kb', '本地文档')
    insertDoc(cloud, 'd-C', 'kb', '云端文档')
  })

  it('孤儿映射被清理、健康映射保留，合并后孤儿=0', () => {
    // 本地健康 chunk + 历史泄漏的孤儿映射（chunk 已不存在）
    insertChunk(local, 'c-L1', 'd-L', 'kb', '本地分块', 100, Buffer.alloc(16, 1))
    insertMap(local, 'c-L1', 1)
    insertMap(local, 'ghost', 2) // chunk 不存在：删文档历史泄漏
    // 云端新增带嵌入的分块（云端新合入行：本地没有它的 vec 行）
    insertChunk(cloud, 'c-C1', 'd-C', 'kb', '云端分块', 200, Buffer.alloc(16, 2))

    const parts = runDbMergeTx(local, cloud, 'cloud')

    expect(orphanMapCount(local)).toBe(0)
    // 健康映射不动（本地 chunk 没被合并触碰）
    expect(local.prepare('SELECT vec_rowid FROM kb_vec_map WHERE chunk_id=?').get('c-L1'))
      .toMatchObject({ vec_rowid: 1 })
    // 云端新合入的 chunk 不伪造映射行（宁可漏召回不可错召回）
    expect(local.prepare('SELECT 1 FROM kb_vec_map WHERE chunk_id=?').get('c-C1')).toBeUndefined()
    // 摘要提示需重建的文档数（c-C1 所在文档缺向量映射）
    expect(parts.some((p) => p.includes('需重建向量索引'))).toBe(true)
  })

  it('冲突更新 chunk 的失配映射被清除（本地旧向量已不匹配云端新内容）', () => {
    insertChunk(local, 'c1', 'd-L', 'kb', '旧内容', 100, Buffer.alloc(16, 1))
    insertMap(local, 'c1', 7)
    insertChunk(cloud, 'c1', 'd-C', 'kb', '新内容', 200, Buffer.alloc(16, 2))

    runDbMergeTx(local, cloud, 'cloud')

    expect(chunkContent(local, 'c1')).toBe('新内容')
    // 该 chunk 被合并触碰过：旧映射指向的向量对应旧内容，必须删掉防错召回
    expect(local.prepare('SELECT 1 FROM kb_vec_map WHERE chunk_id=?').get('c1')).toBeUndefined()
    expect(orphanMapCount(local)).toBe(0)
  })

  it('kb_vec_map 不存在（从未写过向量）→ 收口跳过，合并正常完成', () => {
    local.exec('DROP TABLE kb_vec_map')
    insertChunk(local, 'c-L1', 'd-L', 'kb', '本地分块')
    insertChunk(cloud, 'c-C1', 'd-C', 'kb', '云端分块')

    const parts = runDbMergeTx(local, cloud, 'cloud')

    expect(chunkIds(local).sort()).toEqual(['c-C1', 'c-L1'])
    expect(parts.some((p) => p.startsWith('kb向量映射'))).toBe(false)
  })
})

describe('reconcileKbVecAfterMerge（直调）', () => {
  it('返回清理数与需重建文档数', () => {
    const local = createDb()
    insertKb(local, 'kb', '库')
    insertDoc(local, 'd1', 'kb', '文档1')
    insertDoc(local, 'd2', 'kb', '文档2')
    insertChunk(local, 'c1', 'd1', 'kb', '内容', 100, Buffer.alloc(16, 1))
    insertMap(local, 'c1', 1)
    insertMap(local, 'ghost', 2)
    insertChunk(local, 'c2', 'd2', 'kb', '无嵌入分块', 100, null) // embedding NULL 不参与统计

    const rec = reconcileKbVecAfterMerge(local, new Set())

    expect(rec).toEqual({ removedMaps: 1, docsNeedReindex: 0 })
    expect(orphanMapCount(local)).toBe(0)

    // 触碰过的 chunk：映射失效被删，文档计入需重建（setup 里 c1 的映射行仍在）
    const rec2 = reconcileKbVecAfterMerge(local, new Set(['c1']))
    expect(rec2).toEqual({ removedMaps: 1, docsNeedReindex: 1 })
    expect(orphanMapCount(local)).toBe(0)
  })
})

describe('SEC-16-10 回归 · 凭据列与既有清单不受影响', () => {
  it('providers 凭据列仍保留本机值（CREDENTIAL_COLUMNS 回归）', () => {
    const local = createDb()
    const cloud = createDb()
    insertProvider(local, 'P1', '本机名字', 'v1:LOCAL-KEY')
    insertProvider(cloud, 'P1', '云端名字', 'v1:CLOUD-KEY')
    insertProvider(cloud, 'P2', '云端新增', 'v1:CLOUD-KEY2')

    runDbMergeTx(local, cloud, 'cloud')

    const p1 = local.prepare('SELECT * FROM providers WHERE id=?').get('P1') as Record<string, unknown>
    const p2 = local.prepare('SELECT * FROM providers WHERE id=?').get('P2') as Record<string, unknown>
    expect(p1.name).toBe('云端名字')
    expect(p1.api_key_encrypted).toBe('v1:LOCAL-KEY')
    expect(p2.api_key_encrypted).toBe('v1:CLOUD-KEY2')
  })
})

// 真实 vec0 虚表用例：sqlite-vec 能加载时，验证映射清理连 vec 表行一起删（不是只删 map 行）
const require = createRequire(import.meta.url)
let vecLoaded = false
try {
  const vec = require('sqlite-vec') as { getLoadablePath: () => string; load: (db: unknown, path: string) => void }
  const probe = new Database(':memory:')
  vec.load(probe, vec.getLoadablePath())
  probe.exec('CREATE VIRTUAL TABLE t USING vec0(embedding float[4])')
  probe.close()
  vecLoaded = true
} catch { /* sqlite-vec 不可用：跳过真实虚表用例（映射行清理已有上面用例覆盖） */ }

describe.skipIf(!vecLoaded)('SEC-16-10 · 真实 vec0 虚表的向量行清理', () => {
  function createVecDb(): Database.Database {
    const db = createDb()
    const vec = require('sqlite-vec') as { getLoadablePath: () => string; load: (db: unknown, path: string) => void }
    vec.load(db, vec.getLoadablePath())
    db.exec('CREATE VIRTUAL TABLE kb_vec_4 USING vec0(embedding float[4])')
    return db
  }

  function vecRowCount(db: Database.Database): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM kb_vec_4').get() as { n: number }).n
  }

  it('孤儿/失配清理时 vec 虚表行与映射行一起删', () => {
    const local = createVecDb()
    const cloud = createDb()
    insertKb(local, 'kb', '库')
    insertDoc(local, 'd-L', 'kb', '本地文档')
    insertDoc(cloud, 'd-C', 'kb', '云端文档')

    const emb = (b: number) => Buffer.from(new Float32Array([b, 0, 0, 0]).buffer)
    // vec0 虚表不接受显式 rowid 写入（与 kb-vec.repo.insert 的形状一致），插完按 rowid 读回
    local.prepare('INSERT INTO kb_vec_4(embedding) VALUES (?)').run(emb(1))
    local.prepare('INSERT INTO kb_vec_4(embedding) VALUES (?)').run(emb(2))
    const vecRowids = (local.prepare('SELECT rowid FROM kb_vec_4 ORDER BY rowid').all() as Array<{ rowid: number }>)
      .map((r) => r.rowid)
    const rowidHealthy = vecRowids[0]!
    const rowidGhost = vecRowids[1]!
    insertChunk(local, 'c-L1', 'd-L', 'kb', '本地分块', 100, emb(1))
    insertMap(local, 'c-L1', rowidHealthy)
    insertMap(local, 'ghost', rowidGhost) // chunk 已不存在的孤儿映射
    insertChunk(cloud, 'c-C1', 'd-C', 'kb', '云端分块', 200, emb(3))

    expect(vecRowCount(local)).toBe(2)
    runDbMergeTx(local, cloud, 'cloud')

    expect(orphanMapCount(local)).toBe(0)
    expect(vecRowCount(local)).toBe(1) // ghost 的 vec 行被删，c-L1 的保留
    expect(local.prepare('SELECT vec_rowid FROM kb_vec_map WHERE chunk_id=?').get('c-L1'))
      .toMatchObject({ vec_rowid: rowidHealthy })
    expect(local.prepare('SELECT 1 FROM kb_vec_map WHERE chunk_id=?').get('ghost')).toBeUndefined()
  })
})
