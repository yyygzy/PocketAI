// message.repo 行映射测试
//
// 覆盖 src/main/db/repositories/message.repo.ts 的 rowToRecord：
// DB 行 → MessageRecord 映射（content/status null 兜底、attachments/sources JSON
// 解析与非法 JSON 降级、snake_case → camelCase 透传）。
//
// 策略：mock dbService 的 prepare() 链（捕获 SQL/参数），rowToRecord 为纯函数。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const { state } = vi.hoisted(() => ({
  state: {
    lastSql: '',
    lastParams: [] as unknown[],
    rows: [] as unknown[]
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => {
        state.lastSql = sql
        return {
          all: (...params: unknown[]) => {
            state.lastParams = params
            return state.rows
          },
          run: (...params: unknown[]) => {
            state.lastSql = sql
            state.lastParams = params
            return { changes: 1 }
          }
        }
      }
    })
  }
}))

import { rowToRecord, messageRepo } from '../src/main/db/repositories/message.repo'

beforeEach(() => {
  state.lastSql = ''
  state.lastParams = []
  state.rows = []
})

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
  sources: null,
  usage: null,
  reply_to_id: null,
  starred: 0
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

  it('usage 合法 JSON → 解析为用量对象', () => {
    const rec = rowToRecord({ ...baseRow, usage: '{"promptTokens":10,"completionTokens":5,"totalTokens":15}' })
    expect(rec.usage?.totalTokens).toBe(15)
  })

  it('usage 非法 JSON → 降级为 undefined（不抛错）', () => {
    const rec = rowToRecord({ ...baseRow, usage: '{broken' })
    expect(rec.usage).toBeUndefined()
  })

  it('role 透传（assistant/tool 等角色字符串原样保留）', () => {
    expect(rowToRecord({ ...baseRow, role: 'assistant' }).role).toBe('assistant')
    expect(rowToRecord({ ...baseRow, role: 'tool' }).role).toBe('tool')
  })

  it('reply_to_id 映射为 replyToId（null→null，有值→原样）', () => {
    expect(rowToRecord({ ...baseRow, reply_to_id: null }).replyToId).toBeNull()
    expect(rowToRecord({ ...baseRow, reply_to_id: 'm-old' }).replyToId).toBe('m-old')
  })

  it('starred 映射为 boolean（0/缺列→false，1→true）', () => {
    expect(rowToRecord({ ...baseRow, starred: 0 }).starred).toBe(false)
    expect(rowToRecord({ ...baseRow, starred: 1 }).starred).toBe(true)
    // 旧库行缺列的 undefined 防御
    const legacy = { ...baseRow } as Record<string, unknown>
    delete legacy.starred
    expect(rowToRecord(legacy as unknown as Parameters<typeof rowToRecord>[0]).starred).toBe(false)
  })
})

describe('setStarred — 收藏标记写入', () => {
  it('starred=true → UPDATE starred=1', () => {
    messageRepo.setStarred('m1', true)
    expect(state.lastSql).toContain('UPDATE messages SET starred=?')
    expect(state.lastParams).toEqual([1, 'm1'])
  })

  it('starred=false → UPDATE starred=0', () => {
    messageRepo.setStarred('m2', false)
    expect(state.lastParams).toEqual([0, 'm2'])
  })
})

describe('listStarred — 收藏列表查询', () => {
  const starredRow = {
    id: 'm9',
    conversation_id: 'c9',
    conversation_title: '讨论收藏',
    role: 'assistant',
    content: '回答内容',
    created_at: 999
  }

  it('SQL 含 JOIN 会话标题 + starred 过滤 + 时间倒序 + limit 参数', () => {
    state.rows = [starredRow]
    const items = messageRepo.listStarred(50)
    expect(state.lastSql).toContain('LEFT JOIN conversations')
    expect(state.lastSql).toContain('m.starred = 1')
    expect(state.lastSql).toContain('ORDER BY m.created_at DESC')
    expect(state.lastParams).toEqual([50])
    expect(items).toHaveLength(1)
    expect(items[0]!.id).toBe('m9')
    expect(items[0]!.conversationTitle).toBe('讨论收藏')
    expect(items[0]!.role).toBe('assistant')
  })

  it('会话已删除（JOIN 不到）→ conversationTitle 兜底空串；content null → 空串', () => {
    state.rows = [{ ...starredRow, id: 'm10', conversation_title: null, content: null }]
    const items = messageRepo.listStarred()
    expect(items[0]!.conversationTitle).toBe('')
    expect(items[0]!.content).toBe('')
    // 默认 limit 200
    expect(state.lastParams).toEqual([200])
  })
})
