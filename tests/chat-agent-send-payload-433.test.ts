// V4-Iter-433（P0-4 v1 载荷面）：开关关闭时 payload 里不许出现 agentMode 字段
//
// 后端只认 `payload.agentMode === true`；若前端在关闭时仍发 `agentMode:false`，
// 字段存在本身会误导后续按"有没有这个键"做判断的代码。这里直接跑 ChatModule 实际使用的
// 载荷组装函数（`buildChatSendPayload`），证明两个分支的键集合差异，不挂整棵 ChatModule。
import { describe, it, expect } from 'vitest'
import { buildChatSendPayload } from '../src/renderer/src/modules/chat/send-payload'

const base = {
  requestId: 'r1',
  conversationId: 'c1',
  assistantId: 'a1',
  content: '你好',
  targets: [{ providerId: 'p1', model: 'm1' }]
}

describe('ChatModule 发送载荷：agentMode 键只在开启时出现', () => {
  it('开关开启 ⇒ payload 带 agentMode:true', () => {
    const payload = buildChatSendPayload({ ...base, agentMode: true })
    expect(payload.agentMode).toBe(true)
    expect(Object.prototype.hasOwnProperty.call(payload, 'agentMode')).toBe(true)
  })

  it('开关关闭 ⇒ payload 不带 agentMode 自有属性', () => {
    const payload = buildChatSendPayload({ ...base, agentMode: false })
    expect(Object.prototype.hasOwnProperty.call(payload, 'agentMode')).toBe(false)
    // 兜底：即使调用方读 undefined，也不能读到 true
    expect(payload.agentMode).toBeUndefined()
  })

  it('开启/关闭不改变其他字段（历史、助手、附件、引用）', () => {
    const extra = {
      attachments: [{ type: 'text' as const, name: 'a.txt', mimeType: 'text/plain', size: 1, data: 'x' }],
      replyToId: 'm-old',
      kbRefs: ['kb1']
    }
    const off = buildChatSendPayload({ ...base, ...extra, agentMode: false })
    const on = buildChatSendPayload({ ...base, ...extra, agentMode: true })
    const onRest = { ...on }
    delete onRest.agentMode
    expect(off).toEqual(onRest)
  })
})
