// @vitest-environment jsdom
// 审批明细屏（P0-2c-3，只读 v1）：钉住四件事——
//  ① 空态三态分开：真没有记录 / 筛选筛空（可一键清空）/ 读取失败（绝不画成"没有记录"）；
//  ② 原因文案能映射的映射、映射不上的原样显示，不许吞掉；
//  ③ 隐私口径：只出现脱敏参数与指纹短哈希（前 10 位），整串指纹不上屏；
//  ④ 「加载更多」追加行、五档决定各自可区分。
import { describe, it, expect } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ApprovalAuditPanel } from '../src/renderer/src/modules/settings/ApprovalAuditPanel'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ApprovalAuditPage, ApprovalAuditRow } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }
const FAIL = { ok: false, error: 'PROBE:审批明细读不到' }

const row = (patch: Partial<ApprovalAuditRow> = {}): ApprovalAuditRow => ({
  id: 'id-1',
  conversationId: 'c-1',
  assistantId: null,
  stepIndex: 1,
  toolId: 'shell.exec',
  toolName: 'shell.exec',
  decision: 'user_approve',
  reasonCode: 'USER_APPROVE',
  scope: 'once',
  argsDigest: 'sha256:abcdef1234567890',
  argsRedacted: '{"command":"ls"}',
  actor: 'local_user',
  requestedAt: 1000,
  decidedAt: 7000,
  createdAt: 7000,
  ...patch
})

/** 面板挂载时会同时读活动 + 归档两侧的会话清单；这里统一给空，列表本身不依赖它 */
const mountPanel = (listApprovalEvents: (q: unknown) => ApprovalAuditPage | typeof FAIL): void => {
  stubPocketai({
    listApprovalEvents,
    listConversations: () => []
  })
  mountWithProviders(<ApprovalAuditPanel />)
}

describe('空态三态：真没有 / 筛空 / 读取失败', () => {
  it('没有任何记录 ⇒ 说"还没有审批记录"，不说"筛选为空"', async () => {
    mountPanel(() => ({ rows: [], hasMore: false }))
    await screen.findByText(L('approvalAudit.empty.noRecords'), {}, MOUNT_BUDGET)
    expect(screen.queryByText(L('approvalAudit.empty.filtered'))).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('筛选筛空 ⇒ 说"当前筛选条件下没有记录"，一键清空后回到"还没有记录"', async () => {
    mountPanel(() => ({ rows: [], hasMore: false }))
    await screen.findByText(L('approvalAudit.empty.noRecords'), {}, MOUNT_BUDGET)

    const decisionSelect = document.querySelectorAll('select')[1] as HTMLSelectElement
    fireEvent.change(decisionSelect, { target: { value: 'user_deny' } })

    await screen.findByText(L('approvalAudit.empty.filtered'), {}, MOUNT_BUDGET)
    expect(screen.queryByText(L('approvalAudit.empty.noRecords'))).toBeNull()

    // 空态盒子里那颗「清除筛选」（筛选条上还有一颗同文案的，取最后一颗）
    const clears = screen.getAllByText(L('approvalAudit.filter.clear'))
    fireEvent.click(clears[clears.length - 1] as HTMLElement)

    await screen.findByText(L('approvalAudit.empty.noRecords'), {}, MOUNT_BUDGET)
    expect(screen.queryByText(L('approvalAudit.empty.filtered'))).toBeNull()
  })

  it('读取失败 ⇒ 常驻"读不到"并给重试键，绝不画成"没有记录"', async () => {
    mountPanel(() => FAIL)
    const alert = await screen.findByRole('alert', {}, MOUNT_BUDGET)
    expect(alert.textContent).toBe(L('common.loadFailed').replace('{msg}', FAIL.error))
    expect(screen.queryByText(L('approvalAudit.empty.noRecords')), '失败 ≠ 没有记录').toBeNull()
    expect(screen.queryByText(L('approvalAudit.empty.filtered'))).toBeNull()
    expect(screen.getByText(L('agent.retryRead'))).toBeTruthy()
  })

  it('IPC reject（真抛到渲染层）也落成"读不到"，不落成空', async () => {
    stubPocketai({
      // 真桥走 ipcRenderer.invoke：失败是 Promise reject，不是同步 throw
      listApprovalEvents: () => Promise.reject(new Error('boom')),
      listConversations: () => []
    })
    mountWithProviders(<ApprovalAuditPanel />)
    const alert = await screen.findByRole('alert', {}, MOUNT_BUDGET)
    expect(alert.textContent).toBe(L('common.loadFailed').replace('{msg}', L('common.unknownError')))
    expect(screen.queryByText(L('approvalAudit.empty.noRecords'))).toBeNull()
  })
})

describe('每行显示：原因映射 / 隐私口径 / 时间与等待时长', () => {
  it('已知原因按文案映射；未知 reason_code 原样显示而不是吞掉', async () => {
    mountPanel(() => ({
      rows: [
        row({ id: 'r-known', reasonCode: 'USER_APPROVE' }),
        row({ id: 'r-unknown', reasonCode: 'DENY_RULE:block-shell' })
      ],
      hasMore: false
    }))
    await screen.findByText(L('agent.approval.reason.USER_APPROVE'), {}, MOUNT_BUDGET)
    expect(screen.getByText('DENY_RULE:block-shell')).toBeTruthy()
  })

  it('只展示脱敏参数与指纹前 10 位；整串指纹与原始参数不上屏', async () => {
    mountPanel(() => ({ rows: [row()], hasMore: false }))
    await screen.findByText(L('agent.approval.reason.USER_APPROVE'), {}, MOUNT_BUDGET)
    const body = document.body.textContent ?? ''
    expect(body, '短哈希该在前 10 位').toContain('sha256:abc')
    expect(body, '整串指纹不许上屏').not.toContain('sha256:abcdef1234567890')
    expect(body, '只展示脱敏摘要').toContain('{"command":"ls"}')
    expect(body).toContain(L('approvalAudit.privacy'))
  })

  it('请求/判定时间都在，等待时长由两者算出差值（6 秒）', async () => {
    mountPanel(() => ({ rows: [row({ requestedAt: 1000, decidedAt: 7000 })], hasMore: false }))
    await screen.findByText(L('agent.approval.reason.USER_APPROVE'), {}, MOUNT_BUDGET)
    const body = document.body.textContent ?? ''
    expect(body).toContain(L('approvalAudit.field.requestedAt'))
    expect(body).toContain(L('approvalAudit.field.decidedAt'))
    expect(body).toContain(L('approvalAudit.waitSeconds').replace('{s}', '6'))
    expect(body).toContain(L('approvalAudit.scope.once'))
    expect(body).toContain(L('approvalAudit.actor.localUser'))
  })

  it('五档决定各自可区分', async () => {
    const decisions: Array<ApprovalAuditRow['decision']> = [
      'auto_allow',
      'user_approve',
      'user_deny',
      'timeout_deny',
      'policy_deny'
    ]
    mountPanel(() => ({
      rows: decisions.map((decision, i) => row({ id: `d-${i}`, decision, reasonCode: null })),
      hasMore: false
    }))
    await waitFor(() => expect(document.querySelectorAll('li').length).toBe(5), MOUNT_BUDGET)
    // 只读行内文本：筛选下拉的 <option> 也带着同样的文案，不能拿来充数
    const listText = Array.from(document.querySelectorAll('li')).map((li) => li.textContent ?? '').join('\n')
    expect(listText).toContain(L('approvalAudit.decision.autoAllow'))
    expect(listText).toContain(L('approvalAudit.decision.userApprove'))
    expect(listText).toContain(L('approvalAudit.decision.userDeny'))
    expect(listText).toContain(L('approvalAudit.decision.timeoutDeny'))
    expect(listText).toContain(L('approvalAudit.decision.policyDeny'))
  })
})

describe('加载更多：追加行、到位后不再显示按钮', () => {
  it('第一页有 hasMore ⇒ 按钮在；点一下追加第二页，hasMore=false ⇒ 按钮消失', async () => {
    let call = 0
    mountPanel(() => {
      call += 1
      return call === 1
        ? { rows: [row({ id: 'page-1', toolName: 'tool-one' })], hasMore: true }
        : { rows: [row({ id: 'page-2', toolName: 'tool-two' })], hasMore: false }
    })

    await screen.findByText(L('approvalAudit.loadMore'), {}, MOUNT_BUDGET)
    expect(screen.getByText('tool-one')).toBeTruthy()

    fireEvent.click(screen.getByText(L('approvalAudit.loadMore')))

    await screen.findByText('tool-two', {}, MOUNT_BUDGET)
    expect(screen.getByText('tool-one'), '追加而不是替换').toBeTruthy()
    await waitFor(() => expect(screen.queryByText(L('approvalAudit.loadMore'))).toBeNull(), MOUNT_BUDGET)
  })
})
