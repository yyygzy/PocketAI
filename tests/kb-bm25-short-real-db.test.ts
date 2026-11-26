// 阶段 2：短中文 BM25 辅助路 — 真库端到端
// 为什么用真库：v79 的回填、三个触发器、两张 FTS 表的合并去重都发生在 SQL/迁移层，
// 桩掉 db 就只剩「我调用了我桩的东西」。这里只替日志与路径，迁移/FTS/仓储全真。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-bm25-short'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'
import { buildFtsMatchQuery, cjkSpacedText } from '../src/main/knowledge/fts-query'

const vec = (x: number, y: number) => new Float32Array([x, y, 0])
let doc2 = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  kbRepo.save({
    id: 'kbS', name: '短词库', embeddingProviderId: 'p1', embeddingModel: 'm1',
    chunkSize: 800, chunkOverlap: 200, topK: 5, topN: 3, minScore: 0
  })
  const d1 = kbDocRepo.insert({ kbId: 'kbS', source: 'd1.txt', sourceType: 'txt', title: 'd1' })
  const d2 = kbDocRepo.insert({ kbId: 'kbS', source: 'd2.txt', sourceType: 'txt', title: 'd2' })
  doc2 = d2.id
  kbChunkRepo.insertMany([
    { id: 'c1', docId: d1.id, kbId: 'kbS', sequence: 0, content: '知识库检索系统', embedding: vec(1, 0) },
    { id: 'c2', docId: d1.id, kbId: 'kbS', sequence: 1, content: '今天天气不错', embedding: vec(0.8, 0.2) },
    { id: 'c3', docId: d2.id, kbId: 'kbS', sequence: 0, content: '内存管理指南', embedding: vec(0, 1) },
    { id: 'c4', docId: d2.id, kbId: 'kbS', sequence: 1, content: 'AI 助手可以回答问题', embedding: vec(0.2, 0.8) }
  ])
})

afterAll(() => {
  try { dbService.close() } catch { /* 已关则忽略 */ }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

const ids = (q: string): string[] => kbChunkRepo.bm25Search(q, ['kbS'], 5).map((r) => r.chunkId)

describe('v79 短中文辅助 FTS 表', () => {
  it('迁移建成辅助表与三个触发器，新插入的 chunk 已同步单字展开文本', () => {
    const db = dbService.getHandle()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='kb_chunks_fts_short'").get()).toBeTruthy()
    for (const trigger of ['kb_chunks_short_ai', 'kb_chunks_short_ad', 'kb_chunks_short_au']) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger)).toBeTruthy()
    }
    const row = db.prepare("SELECT content FROM kb_chunks_fts_short WHERE chunk_id='c1'").get() as { content: string }
    expect(row.content).toBe(cjkSpacedText('知识库检索系统'))
  })

  it('1 字中文命中（改前 trigram 恒空，向量路只是语义相近不保证字面命中）', () => {
    expect(ids('库')).toContain('c1')
    expect(ids('天')).toContain('c2')
    expect(ids('存')).toContain('c3')
  })

  it('2 字中文命中', () => {
    expect(ids('知识')).toContain('c1')
    expect(ids('天气')).toContain('c2')
    expect(ids('内存')).toContain('c3')
  })

  it('短拉丁词也补上：AI 命中', () => {
    expect(ids('AI')).toContain('c4')
  })

  it('长查询回归对照：≥3 字只走 trigram 主路，结果与旧逻辑逐条一致', () => {
    const q = '知识库检索'
    const expr = buildFtsMatchQuery(q)!
    const db = dbService.getHandle()
    // 旧逻辑：直接查 kb_chunks_fts，bm25 升序取前 5 —— 新实现必须与之逐条相同
    const legacy = (
      db
        .prepare(
          `SELECT chunk_id FROM kb_chunks_fts WHERE kb_chunks_fts MATCH ? AND kb_id IN (?)
           ORDER BY bm25(kb_chunks_fts) ASC LIMIT 5`
        )
        .all(expr, 'kbS') as Array<{ chunk_id: string }>
    ).map((r) => r.chunk_id)
    expect(legacy).toContain('c1')
    expect(ids(q)).toEqual(legacy)
  })

  it('存量库升级：回退 v79 痕迹后重跑迁移，辅助表回填全部既有 chunk', () => {
    const db = dbService.getHandle()
    db.exec(`
      DROP TRIGGER IF EXISTS kb_chunks_short_ai;
      DROP TRIGGER IF EXISTS kb_chunks_short_ad;
      DROP TRIGGER IF EXISTS kb_chunks_short_au;
      DROP TABLE IF EXISTS kb_chunks_fts_short;
      DELETE FROM schema_migrations WHERE version=79;
    `)
    dbService.runMigrations()
    const rows = db
      .prepare('SELECT chunk_id, content FROM kb_chunks_fts_short ORDER BY chunk_id')
      .all() as Array<{ chunk_id: string; content: string }>
    expect(rows).toHaveLength(4)
    expect(rows.find((r) => r.chunk_id === 'c1')?.content).toBe(cjkSpacedText('知识库检索系统'))
    // 回填后查询仍可用 ⇒ 触发器随迁移一并重建
    expect(ids('库')).toContain('c1')
  })

  it('内容更新与文档删除时辅助表同步（触发器）', () => {
    const db = dbService.getHandle()
    db.prepare('UPDATE kb_chunks SET content=? WHERE id=?').run('版本升级说明', 'c3')
    expect(ids('内存')).not.toContain('c3')
    expect(ids('版本')).toContain('c3')
    kbChunkRepo.deleteByDoc(doc2)
    expect(ids('版本')).not.toContain('c3')
    expect(ids('AI')).not.toContain('c4')
  })
})
