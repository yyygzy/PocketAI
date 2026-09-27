// 会话导入边界校验测试（普通 JSON 导入 / 加密导入共用同一套上限）
import { describe, it, expect } from 'vitest'
import {
  conversationImportDataSchema,
  conversationExportPayloadSchema,
  CONVERSATION_IMPORT_MAX_MESSAGES,
  CONVERSATION_IMPORT_MAX_CONTENT_CHARS,
  CONVERSATION_IMPORT_MAX_TITLE_CHARS
} from '../src/shared/schemas/conversations'

/** 加密导入的最小合法载荷（宽松：id/时间戳等可缺） */
function minimalImportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation: { title: '测试会话' },
    messages: [{ role: 'user', content: '你好' }],
    ...overrides
  }
}

describe('conversationImportDataSchema（加密导入解密后校验）', () => {
  it('最小合法载荷通过，缺失 content 默认空串', () => {
    const r = conversationImportDataSchema.parse(minimalImportPayload({ messages: [{ role: 'assistant' }] }))
    expect(r.messages[0]!.content).toBe('')
    expect(r.conversation.title).toBe('测试会话')
  })

  it('conversation 缺失 → 拒绝', () => {
    const p = minimalImportPayload()
    delete p.conversation
    expect(conversationImportDataSchema.safeParse(p).success).toBe(false)
  })

  it('messages 不是数组 → 拒绝', () => {
    expect(conversationImportDataSchema.safeParse(minimalImportPayload({ messages: {} })).success).toBe(false)
  })

  it('非法 role → 拒绝', () => {
    const r = conversationImportDataSchema.safeParse(
      minimalImportPayload({ messages: [{ role: 'admin', content: 'x' }] })
    )
    expect(r.success).toBe(false)
  })

  it('content 为非字符串（对象/数字）→ 拒绝', () => {
    expect(
      conversationImportDataSchema.safeParse(
        minimalImportPayload({ messages: [{ role: 'user', content: { huge: 'obj' } }] })
      ).success
    ).toBe(false)
    expect(
      conversationImportDataSchema.safeParse(
        minimalImportPayload({ messages: [{ role: 'user', content: 12345 }] })
      ).success
    ).toBe(false)
  })

  it('content 恰好达上限 → 通过；超 1 字符 → 拒绝', () => {
    const ok = minimalImportPayload({
      messages: [{ role: 'user', content: 'x'.repeat(CONVERSATION_IMPORT_MAX_CONTENT_CHARS) }]
    })
    expect(conversationImportDataSchema.safeParse(ok).success).toBe(true)
    const bad = minimalImportPayload({
      messages: [{ role: 'user', content: 'x'.repeat(CONVERSATION_IMPORT_MAX_CONTENT_CHARS + 1) }]
    })
    expect(conversationImportDataSchema.safeParse(bad).success).toBe(false)
  })

  it('消息数恰好 10000 → 通过；10001 → 拒绝', () => {
    const mk = (n: number) =>
      minimalImportPayload({
        messages: Array.from({ length: n }, () => ({ role: 'user' as const, content: 'x' }))
      })
    expect(conversationImportDataSchema.safeParse(mk(CONVERSATION_IMPORT_MAX_MESSAGES)).success).toBe(true)
    expect(conversationImportDataSchema.safeParse(mk(CONVERSATION_IMPORT_MAX_MESSAGES + 1)).success).toBe(false)
  })

  it('标题超长 → 拒绝', () => {
    const r = conversationImportDataSchema.safeParse(
      minimalImportPayload({ conversation: { title: 't'.repeat(CONVERSATION_IMPORT_MAX_TITLE_CHARS + 1) } })
    )
    expect(r.success).toBe(false)
  })

  it('assistantId 类型非法（数字）→ 拒绝', () => {
    const r = conversationImportDataSchema.safeParse(
      minimalImportPayload({ conversation: { title: 't', assistantId: 999 } })
    )
    expect(r.success).toBe(false)
  })

  it('provider/model 为 null 或缺省 → 通过（宽松兼容旧导出）', () => {
    const r = conversationImportDataSchema.parse(
      minimalImportPayload({
        messages: [{ role: 'assistant', content: 'ok', provider: null, model: null, status: 'done' }]
      })
    )
    expect(r.messages[0]!.provider).toBeNull()
  })
})

describe('conversationExportPayloadSchema（普通 JSON 导入，同样受上限约束）', () => {
  function fullPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      exportedAt: Date.now(),
      conversation: {
        id: 'c1',
        assistantId: null,
        title: '完整导出',
        modelLabel: null,
        status: 'active',
        createdAt: 1,
        updatedAt: 2
      },
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          role: 'user',
          content: 'hi',
          createdAt: 1
        }
      ],
      ...overrides
    }
  }

  it('合法完整导出通过', () => {
    expect(conversationExportPayloadSchema.safeParse(fullPayload()).success).toBe(true)
  })

  it('消息内容超 100 万字符 → 拒绝', () => {
    const p = fullPayload({
      messages: [
        {
          id: 'm1',
          conversationId: 'c1',
          role: 'user',
          content: 'x'.repeat(CONVERSATION_IMPORT_MAX_CONTENT_CHARS + 1),
          createdAt: 1
        }
      ]
    })
    expect(conversationExportPayloadSchema.safeParse(p).success).toBe(false)
  })

  it('消息数超 10000 → 拒绝', () => {
    const p = fullPayload({
      messages: Array.from({ length: CONVERSATION_IMPORT_MAX_MESSAGES + 1 }, (_, i) => ({
        id: `m${i}`,
        conversationId: 'c1',
        role: 'user',
        content: 'x'
      }))
    })
    expect(conversationExportPayloadSchema.safeParse(p).success).toBe(false)
  })
})
