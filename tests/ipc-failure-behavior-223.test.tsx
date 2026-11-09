// @vitest-environment jsdom
// V4-Iter-223：闸门新两档（`value-use`／链根识别）逼出的点，挑两处演成界面事实。
//
// 这两处的共同点是"以前闸门根本看不见"：
//   ① `setItems(await listReminders())` —— 绑定失败 ⇒ bound 为 null ⇒ 旧口径只看"有没有包 try…catch"，
//      于是它一路绿灯，而失败对象进 state 后 `items.length` 为假、`items.map` 当场 TypeError（提醒中心打不开）；
//   ② `(await getEncryptionStatus()).mode` —— 同上，且这条判定决定"要不要弹凭据确认"，静默错过不可审计；
// 反向对照各一条：改"失败要留痕"改到"成功也留痕／成功不生效"同样是回归。
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { isUnprotectedMode } from '../src/renderer/src/utils/secret-consent'
import { zh } from '../src/renderer/src/i18n/zh'

const ZH = zh as unknown as Record<string, string>
const L = (key: string): string => ZH[key]!
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const settleAfter = async (fn: string): Promise<void> => {
  await waitFor(() => expect(calledFns()).toContain(fn))
  await settle()
}

const FAIL = { ok: false, error: '库被占用' }

beforeAll(() => {
  Element.prototype.scrollIntoView = () => { /* jsdom 没有布局，滚动是空操作 */ }
})

describe('① 提醒中心：改前 `{ok:false}` 直接写进列表 state ⇒ 那句 `items.map` 当场崩', () => {
  const reminder = { id: 'r1', dueAt: Date.now() + 60_000, text: '探针提醒', status: 'pending' }

  it('listReminders 回 {ok:false} ⇒ 不崩、明说「读不到：库被占用」，且「加载中…」不在场', async () => {
    stubPocketai({
      listReminders: () => FAIL,
      onReminderFired: () => () => { /* 订阅卸载函数 */ },
      onReminderChanged: () => () => { /* 同上 */ }
    })
    mountWithProviders(<RemindersModal onClose={() => { /* 用例不关心关闭 */ }} />)
    await settleAfter('listReminders')
    expect(alerts()).toEqual([FAILED('库被占用')])
    expect(screen.queryByText(L('common.loading'))).toBeNull()
    // 崩了的形状是"整个 modal 空白"：这里以标题仍在为证（改前是 React 抛错后什么都不剩）。
    // 标题带 emoji 前缀（`⏰ 提醒中心`），所以用子串匹配而不是整串相等
    expect(screen.getAllByText(L('reminder.center.title'), { exact: false }).length).toBeGreaterThan(0)
  })

  it('反向对照：读到一条 ⇒ 列表里就是那条，一个 alert 都没有', async () => {
    stubPocketai({
      listReminders: () => [reminder],
      onReminderFired: () => () => { /* 同上 */ },
      onReminderChanged: () => () => { /* 同上 */ }
    })
    mountWithProviders(<RemindersModal onClose={() => { /* 同上 */ }} />)
    await settleAfter('listReminders')
    expect(alerts()).toEqual([])
    expect(screen.getByText('探针提醒')).toBeTruthy()
  })
})

describe('② 凭据确认的前置判定：resolve 的失败以前一句痕都不留（catch 进不去）', () => {
  it('getEncryptionStatus 回 {ok:false} ⇒ 结论仍是"不必打扰"（B3 既有口径），但 console.warn 里要留痕', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 收着，别刷 CI */ })
    stubPocketai({ getEncryptionStatus: () => FAIL })
    await expect(isUnprotectedMode()).resolves.toBe(false)
    expect(warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n')).toContain('secretConsent.getEncryptionStatus')
    warn.mockRestore()
  })

  it('反向对照：读到 mode=db ⇒ 说"不是明文"，且不打痕（留痕不是"每次都喊一声"）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* 同上 */ })
    stubPocketai({ getEncryptionStatus: () => ({ mode: 'db', dbEncrypted: true }) })
    await expect(isUnprotectedMode()).resolves.toBe(false)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})


