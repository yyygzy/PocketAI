// 审批弹窗那条「无操作自动拒绝」提示（V4-Iter-160 ④）
//
// 为什么要接回：`tool-approval.ts:25` 真的有一条 5 分钟定时器（`setTimeout(() => settle(false), APPROVAL_TIMEOUT_MS)`），
// 但界面上只有**过期之后**那句 `agent.approval.expired`，事前没有任何一处告诉用户"放着不点会自动拒绝"。
// 这条键（`agent.approval.autoRejectHint`）因此在 159 的死键普查里被扫出来——它属于**提示缺失**，不是改名遗留，
// 所以处置是接回而不是删（B95 判定表里唯一一条"接回"）。
//
// 两条各自独立的牙：
//  ① 真挂载：pending 事件到得了才看得见这句话，没事件时整块不渲染（反向对照，防"永远在页脚显示"的假通过）；
//  ② 数字同源：四语文案里写的分钟数必须等于 `APPROVAL_TIMEOUT_MS` 换算出来的分钟数——
//     改代码里的 5 分钟而忘了改文案，这里就红（153「名字只有一个出处」在数字上的同款）。
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, cleanup, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ToolApprovalDialog } from '../src/renderer/src/components/ToolApprovalDialog'
import { APPROVAL_TIMEOUT_MS } from '../src/main/agent/tool-approval'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

let fire: ((evt: unknown) => void) | null = null

beforeEach(() => {
  fire = null
  stubPocketai({
    onToolApprovalRequest: (cb: (evt: unknown) => void) => {
      fire = cb
      return () => { fire = null }
    },
    respondToolApproval: vi.fn(async () => true)
  })
})

afterEach(() => cleanup())

const REQ = {
  approvalId: 'a1',
  requestId: 'r1',
  conversationId: 'c1',
  toolName: 'shell_exec',
  command: 'rm -rf ./build',
  reason: 'REQUIRES_CONFIRM',
  risk: 'custom'
}

describe('审批弹窗的自动拒绝提示', () => {
  it('① 有待审批请求时，那句话出现在弹窗里', async () => {
    mountWithProviders(<ToolApprovalDialog />)
    expect(screen.queryByText(zh['agent.approval.autoRejectHint'])).toBeNull() // 反向对照：空队列不渲染
    await act(async () => { fire?.(REQ) })
    expect(await screen.findByText(zh['agent.approval.warning'])).toBeTruthy()
    expect(screen.getByText(zh['agent.approval.autoRejectHint'])).toBeTruthy()
  })

  it('② 四语写的分钟数 = APPROVAL_TIMEOUT_MS（不许两边各写一遍）', () => {
    const minutes = Math.round(APPROVAL_TIMEOUT_MS / 60000)
    expect(minutes).toBeGreaterThan(0)
    for (const [lang, d] of Object.entries({ zh, en, ja, ko }) as Array<[string, Record<string, string>]>) {
      const text = d['agent.approval.autoRejectHint']
      expect(text, `${lang} 缺这句`).toBeTruthy()
      expect(text, `${lang} 这句里没有 ${minutes} 分钟（代码里的超时已改，文案没跟）`).toContain(String(minutes))
    }
  })
})
