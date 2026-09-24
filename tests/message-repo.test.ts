// message.repo 行映射测试
//
// 覆盖 src/main/db/repositories/message.repo.ts 的 rowToRecord：
// DB 行 → MessageRecord 映射（content/status null 兜底、attachments/sources JSON
// 解析与非法 JSON 降级、snake_case → camelCase 透传）。
//
// 策略：纯函数，mock dbService 避免模块加载时初始化。
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({}) } }))

import { rowToRecord } from '../src/main/db/repositories/message.repo'

const baseRow = {
  id: 'm1',
  conversation_id: 'c1',
  role: 'user',
  content: '你好',
  provider: null,
  model: null,
  status: 'done',
  parent_id: null,
  created_at: 100,
  tool_calls: null,
  attachments: null,
  batch_id: null,
  sources: null
}

describe('rowToRecord — DB 行映射为 MessageRecord', () => {
  it('全 null 可选字段 → 默认值填充（content→""、status→done、attachments/sources→undefined）', () => {
    const rec = rowToRecord({ ...baseRow, content: null, status: null })
    expect(rec.id).toBe('m1')
    expect(rec.conversationId).toBe('c1')
    expect(rec.role).toBe('user')
    expect(rec.content).toBe('')
    expect(rec.status).toBe('done')
    expect(rec.toolCalls).toBeNull()
    expect(rec.attachments).toBeUndefined()
    expect(rec.sources).toBeUndefined()
    expect(rec.createdAt).toBe(100)
  })

  it('非空字段透传，snake_case → camelCase', () => {
    const rec = rowToRecord({
      ...baseRow,
      conversation_id: 'c2',
      provider: 'openai',
      model: 'gpt-4o',
      parent_id: 'p1',
      batch_id: 'b1',
      tool_calls: '[{"id":"tc1"}]'
    })
    expect(rec.conversationId).toBe('c2')
    expect(rec.provider).toBe('openai')
    expect(rec.model).toBe('gpt-4o')
    expect(rec.parentId).toBe('p1')
    expect(rec.batchId).toBe('b1')
    expect(rec.toolCalls).toBe('[{"id":"tc1"}]')
  })

  it('status 非 null → 原样保留（error/aborted/streaming）', () => {
    expect(rowToRecord({ ...baseRow, status: 'error' }).status).toBe('error')
    expect(rowToRecord({ ...baseRow, status: 'aborted' }).status).toBe('aborted')
    expect(rowToRecord({ ...baseRow, status: 'streaming' }).status).toBe('streaming')
  })

  it('attachments 合法 JSON → 解析为 ChatAttachment 数组', () => {
    const atts = [
      { type: 'text', name: 'a.txt', data: '内容', mimeType: 'text/plain', size: 6 },
      { type: 'image', name: 'p.png', data: 'data:image/png;base64,x', mimeType: 'image/png', size: 1 }
    ]
    const rec = rowToRecord({ ...baseRow, attachments: JSON.stringify(atts) })
    expect(rec.attachments).toHaveLength(2)
    expect(rec.attachments![0]!.name).toBe('a.txt')
    expect(rec.attachments![1]!.type).toBe('image')
  })

  it('attachments 非法 JSON → 降级为 undefined（不抛错）', () => {
    const rec = rowToRecord({ ...baseRow, attachments: '{not-json' })
    expect(rec.attachments).toBeUndefined()
  })

  it('sources 合法 JSON → 解析为来源数组', () => {
    const sources = [{ chunkId: 'ck1', docId: 'd1', docTitle: '文档', content: '片段' }]
    const rec = rowToRecord({ ...baseRow, sources: JSON.stringify(sources) })
    expect(rec.sources).toHaveLength(1)
    expect(rec.sources![0]!.docId).toBe('d1')
  })

  it('sources 非法 JSON → 降级为 undefined（不抛错）', () => {
    const rec = rowToRecord({ ...baseRow, sources: '[broken' })
    expect(rec.sources).toBeUndefined()
  })

  it('role 透传（assistant/tool 等角色字符串原样保留）', () => {
    expect(rowToRecord({ ...baseRow, role: 'assistant' }).role).toBe('assistant')
    expect(rowToRecord({ ...baseRow, role: 'tool' }).role).toBe('tool')
  })
})
