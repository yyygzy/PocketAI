// PERF-07：N+1 查询收口验收
// - kb.repo.list/get：1000 行列表只发 1 条 prepare（GROUP BY 聚合计数）
// - skill.repo.listEnabledByIds：批量 IN，按 500 分片，保持顺序并过滤禁用项
// - attachment-ingestion.deleteMessageAttachmentDocs：走 kbDocRepo.listIdsBySource（索引列），不再 listAll 全表扫
import { describe, it, expect, vi, beforeEach } from 'vitest'

const state = vi.hoisted(() => ({
  prepareCalls: 0,
  sqls: [] as string[],
  allResult: [] as unknown[],
  getResult: undefined as unknown
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare(sql: string) {
        state.prepareCalls++
        state.sqls.push(sql)
        return {
          all: () => {
            // 极简 SQL 语义：批量 IN 查询带 enabled=1 条件，mock 侧过滤掉禁用行
            if (state.sqls.at(-1)?.includes('enabled=1')) {
              return state.allResult.filter(
                (r) => (r as { enabled?: number }).enabled === 1
              )
            }
            return state.allResult
          },
          get: () => state.getResult,
          run: () => ({ changes: 1 })
        }
      }
    })
  }
}))
vi.mock('../src/main/db/must-get', () => ({ mustGet: (fn: () => unknown) => fn() }))

const attachment = vi.hoisted(() => ({
  deleted: [] as string[],
  idsBySource: [] as string[],
  listAllCalls: 0
}))
vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: {
    listAll: () => { attachment.listAllCalls++; return [] },
    listIdsBySource: (source: string) => { attachment.idsBySource.push(source); return [...attachment.deleted] },
    delete: (id: string) => { attachment.deleted.push(`deleted:${id}`) }
  }
}))
vi.mock('../src/main/db/repositories/message.repo', () => ({ messageRepo: {} }))
vi.mock('../src/main/knowledge/ingestion', () => ({ ingestionService: {} }))
vi.mock('../src/main/knowledge/ocr', () => ({ ocrImageDataUrl: async () => '' }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { skillRepo } from '../src/main/db/repositories/skill.repo'
import { deleteMessageAttachmentDocs } from '../src/main/attachment/attachment-ingestion'

const kbRow = (i: number) => ({
  id: `kb${i}`,
  name: `KB${i}`,
  description: null,
  embedding_provider_id: null,
  embedding_model: null,
  embedding_dim: null,
  chunk_size: 800,
  chunk_overlap: 200,
  top_k: 20,
  top_n: 5,
  min_score: 0,
  rerank_provider_id: null,
  rerank_model: null,
  hyde_provider_id: null,
  hyde_model: null,
  multiquery_provider_id: null,
  multiquery_model: null,
  ocr_provider_id: null,
  ocr_model: null,
  created_at: i,
  doc_count: i,
  chunk_count: i * 7
})

const skillRow = (id: string, enabled: number) => ({
  id,
  name: id,
  description: null,
  icon: null,
  content: null,
  category: '',
  tags: '[]',
  enabled,
  resident: 1,
  is_builtin: 0,
  created_at: 1
})

beforeEach(() => {
  state.prepareCalls = 0
  state.sqls = []
  state.allResult = []
  state.getResult = undefined
  attachment.deleted = []
  attachment.idsBySource = []
  attachment.listAllCalls = 0
})

describe('PERF-07 · kb.repo 列表计数', () => {
  it('1000 行列表只发 1 条 SQL（O(1)），计数取自 GROUP BY 聚合列', () => {
    state.allResult = Array.from({ length: 1000 }, (_, i) => kbRow(i))
    const rows = kbRepo.list()
    expect(rows).toHaveLength(1000)
    expect(state.prepareCalls).toBe(1)
    expect(state.sqls[0]).toContain('GROUP BY kb_id')
    expect(rows[999]?.documentCount).toBe(999)
    expect(rows[999]?.chunkCount).toBe(999 * 7)
  })

  it('get 单条也走聚合 SQL，只发 1 条，不再额外 COUNT', () => {
    state.getResult = kbRow(42)
    const row = kbRepo.get('kb42')
    expect(state.prepareCalls).toBe(1)
    expect(row?.documentCount).toBe(42)
  })
})

describe('PERF-07 · skill.repo 批量查询', () => {
  it('600 个 id 分 2 批 IN 查询，保持传入顺序并跳过禁用项', () => {
    const ids = Array.from({ length: 600 }, (_, i) => `s${i}`)
    state.allResult = ids.map((id, i) => skillRow(id, i === 3 ? 0 : 1))
    const rows = skillRepo.listEnabledByIds(ids)
    expect(state.prepareCalls).toBe(2)
    expect(state.sqls[0]).toContain('enabled=1 AND id IN')
    expect(rows).toHaveLength(599)
    expect(rows[0]?.id).toBe('s0')
    expect(rows.find((r) => r.id === 's3')).toBeUndefined()
  })
})

describe('PERF-07 · 附件引用判断', () => {
  it('删除消息文档按 source 精确查 id，不调用 listAll 全表扫', () => {
    attachment.deleted = ['d1', 'd2']
    deleteMessageAttachmentDocs('m1')
    expect(attachment.idsBySource).toEqual(['msg_m1'])
    expect(attachment.listAllCalls).toBe(0)
    expect(attachment.deleted).toEqual(['d1', 'd2', 'deleted:d1', 'deleted:d2'])
  })
})
