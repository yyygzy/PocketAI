// CONVERSATION_SET_ASSISTANT 入参 schema（会话 id + 目标助手 id，null=自由会话）
import { describe, it, expect } from 'vitest'
import { conversationSetAssistantArgsSchema } from '../src/shared/schemas/conversations'

const ok = (id: string, assistantId: string | null) =>
  conversationSetAssistantArgsSchema.safeParse({ id, assistantId })

describe('conversationSetAssistantArgsSchema', () => {
  it('合法：带目标助手 / 回自由会话（null）', () => {
    expect(ok('c1', 'a-1').success).toBe(true)
    expect(ok('c1', null).success).toBe(true)
  })

  it('缺字段或形状不对一律拒', () => {
    expect(conversationSetAssistantArgsSchema.safeParse({ id: 'c1' }).success).toBe(false)
    expect(conversationSetAssistantArgsSchema.safeParse({ assistantId: null }).success).toBe(false)
    expect(conversationSetAssistantArgsSchema.safeParse('c1').success).toBe(false)
  })

  it('空串 id 拒绝（避免误命中 assistant_id=""的脏行）', () => {
    expect(ok('', 'a-1').success).toBe(false)
    expect(ok('c1', '').success).toBe(false)
  })

  it('超长 id 拒绝（UUID 尺度，超长即畸形输入）', () => {
    expect(ok('c'.repeat(65), 'a-1').success).toBe(false)
    expect(ok('c'.repeat(64), 'a'.repeat(64)).success).toBe(true)
  })

  it('undefined 不算「自由会话」：只有 null 放行，防漏传字段静默把会话搬去自由列表', () => {
    expect(
      conversationSetAssistantArgsSchema.safeParse({ id: 'c1', assistantId: undefined }).success
    ).toBe(false)
  })
})
