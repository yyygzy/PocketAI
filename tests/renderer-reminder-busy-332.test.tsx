// V4-Iter-332（提醒中心那颗单槽位）：连点两行取消时，A 那发的回执不许解锁 B 那一行
//
// 改前 `busyId` 是一格（不是"哪些行在飞"）：连点 A、B 两行「取消」⇒ A 先回来，
// `finally` 把那一格清掉，而 B 那一发还在飞 ⇒ **B 的按钮重新可点**，双击 B 就得到第二次
// `{ok:false}`（已取消的不能重复取消）⇒ 屏上弹一句「取消失败（提醒可能已触发）」，
// 而那两条其实都取消成功了。修法：在飞态按"行"存（`busyIds: Record<string, true>` ＋ `markBusy`）。
//
// 这条与 §311 的「切 tab」那条同屏不同轴：那条守的是"哪一份列表"，这条守的是"哪一行在飞"。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent, waitFor, act } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import { zh } from '../src/renderer/src/i18n/zh'
import type { ReminderRecord } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const MOUNT_BUDGET = { timeout: 8000, interval: 50 }

let q: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(q[key] ??= []).push(resolve)
  })
const answer = (key: string, v: unknown): void => {
  const queue = q[key] ?? []
  q[key] = []
  queue.forEach((resolve) => resolve(v))
}
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
/** `await cancel → await reload → finally` 是三层，一次 settle 刷不干净 */
const flush = async (fn?: () => void): Promise<void> => {
  await act(async () => {
    fn?.()
    await settle()
    await settle()
  })
}

const reminder = (id: string, text: string): ReminderRecord =>
  ({
    id, text, fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(), status: 'pending',
    conversationId: null, createdAt: new Date(2026, 9, 10, 8, 0, 0).getTime()
  }) as unknown as ReminderRecord

const CANCEL = L('reminder.center.cancel')
const cancelBtns = (): HTMLButtonElement[] =>
  screen.getAllByText(CANCEL).map((el) => el.closest('button') as HTMLButtonElement)

beforeEach(() => {
  q = {}
  localStorage.clear()
  stubPocketai({
    listReminders: (scope: string) => pend(`rem:${scope}`),
    onReminderFired: () => () => {},
    cancelReminder: (id: string) => pend(`cancel:${id}`),
    rescheduleNextReminder: () => ({ ok: true }),
    updateReminder: () => ({ ok: true })
  })
  mountWithProviders(<RemindersModal onClose={() => {}} />)
})

describe('§332 提醒中心：在飞态一行一格', () => {
  it('连点 A、B 两行「取消」⇒ A 的回执不许解锁 B 那一行（B 回来后两行才都解锁）', async () => {
    await waitFor(() => expect(q['rem:pending']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('rem:pending', [reminder('a', '那条甲'), reminder('b', '那条乙')]))
    const btns = cancelBtns()
    expect(btns.length, '两行各有那颗「取消」').toBe(2)

    fireEvent.click(btns[0]!)
    fireEvent.click(btns[1]!)
    await waitFor(() => expect(q['cancel:a']?.length && q['cancel:b']?.length).toBeTruthy(), MOUNT_BUDGET)
    expect(cancelBtns().map((b) => b.disabled), '两行都在飞 ⇒ 两行都禁点').toEqual([true, true])

    // A 先回：取消成功 → reload 那一发也要放行（`finally` 排在 reload 之后）
    await flush(() => answer('cancel:a', { ok: true }))
    await waitFor(() => expect(q['rem:pending']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('rem:pending', [reminder('a', '那条甲'), reminder('b', '那条乙')]))

    const after = cancelBtns()
    expect(after[0]!.disabled, 'A 已经回来 ⇒ 那一行解锁').toBe(false)
    expect(after[1]!.disabled, 'B 那一发还在飞 ⇒ 单槽位会被 A 的回执顺手解锁（改前就是这样）').toBe(true)

    await flush(() => answer('cancel:b', { ok: true }))
    await waitFor(() => expect(q['rem:pending']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('rem:pending', [reminder('a', '那条甲'), reminder('b', '那条乙')]))
    expect(cancelBtns().map((b) => b.disabled), '两行都回来才都解锁').toEqual([false, false])
  })

  it('反向钉：B 那发失败只说 B 那一句（A 还在飞 ⇒ 那一行不许被 B 的回执解锁）', async () => {
    await waitFor(() => expect(q['rem:pending']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('rem:pending', [reminder('a', '那条甲'), reminder('b', '那条乙')]))
    fireEvent.click(cancelBtns()[0]!)
    fireEvent.click(cancelBtns()[1]!)
    await waitFor(() => expect(q['cancel:a']?.length && q['cancel:b']?.length).toBeTruthy(), MOUNT_BUDGET)

    await flush(() => answer('cancel:b', { ok: false }))
    await waitFor(() => expect(q['rem:pending']?.length).toBeTruthy(), MOUNT_BUDGET)
    await flush(() => answer('rem:pending', [reminder('a', '那条甲'), reminder('b', '那条乙')]))
    const toasts = screen.queryAllByRole('status').map((el) => el.textContent ?? '')
    expect(toasts.join(' '), 'B 那句「取消失败」要上屏').toContain(L('reminder.center.cancelFail'))
    expect(toasts.join(' '), 'A 那句成功话术不许替 A 说话（A 还没回来）').not.toContain(L('reminder.center.cancelOk'))
    expect(cancelBtns()[1]!.disabled, 'B 回来（哪怕失败）⇒ 那一行解锁').toBe(false)
    expect(cancelBtns()[0]!.disabled, 'A 还在飞 ⇒ 那一行不许被 B 的回执解锁（同一枚机关的反方向）').toBe(true)
  })
})
