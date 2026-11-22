// 第三批审查项回归：
//  M2 用户停止被渲染层记成 done，误报"回复已完成"并聚焦摘要
//  M5 OAuth「清除授权」不取消进行中的授权，回调把凭据写回
//  M6 队列自动发送被拒后消息静默丢失
//  M7 isAbortError 对 DOMException 型 TimeoutError 返回 false，绘图超时文案不可达
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { isAbortError } from '../src/main/error'

describe('M2 · 停止事件按真实状态结算', () => {
  it('ChatDoneEvent 带可选 status，aborted 分支写入 status', () => {
    const types = readFileSync('src/shared/types.ts', 'utf8')
    expect(types).toMatch(/status\?: 'done' \| 'aborted'/)
    const svc = readFileSync('src/main/chat/chat-service.ts', 'utf8')
    expect(svc).toMatch(/status: 'aborted'/)
    const hook = readFileSync('src/renderer/src/modules/chat/useStreamSession.ts', 'utf8')
    expect(hook).toMatch(/e\.status === 'aborted' \? 'aborted' : 'done'/)
  })
})

describe('M5 · 清除授权取消进行中的流程', () => {
  it('clear() 先调用 cancelAuth(serverId)', () => {
    const src = readFileSync('src/main/mcp/oauth/service.ts', 'utf8')
    const i = src.indexOf('async clear(serverId: string): Promise<void>')
    const j = src.indexOf('this.cancelAuth(serverId)', i)
    expect(i).toBeGreaterThan(-1)
    expect(j).toBeGreaterThan(i)
    expect(src.slice(i, j)).not.toMatch(/this\.deps\.repo\.clear/)
  })
})

describe('M6 · 队列自动发送失败回退', () => {
  it('useAgentQueue 暴露 restoreSent 并用新 clientRef 放回队尾', () => {
    const src = readFileSync('src/renderer/src/modules/chat/useAgentQueue.ts', 'utf8')
    expect(src).toMatch(/restoreSent: \(text: string\) => void/)
    expect(src).toMatch(/q_restore_\$\{Date\.now\(\)\}/)
  })

  it('ChatModule 在发送失败置位并归回队列', () => {
    const src = readFileSync('src/renderer/src/modules/chat/ChatModule.tsx', 'utf8')
    expect(src).toMatch(/queueSendFailedRef\.current = true/)
    expect(src).toMatch(/restoreQueuedSent\(text\)/)
  })
})

describe('M7 · isAbortError 覆盖 DOMException 型 TimeoutError', () => {
  it('DOMException{name:TimeoutError} 识别为 abort/timeout', () => {
    expect(isAbortError(new DOMException('timeout', 'TimeoutError'))).toBe(true)
  })

  it('DOMException{name:AbortError} 仍识别，普通 Error 不误伤', () => {
    expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true)
    expect(isAbortError(new Error('other'))).toBe(false)
  })
})
