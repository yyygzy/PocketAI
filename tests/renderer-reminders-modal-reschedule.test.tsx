// @vitest-environment jsdom
// 终态提醒行的「改期」入口：后端 REMINDER_RESCHEDULE 早就通了，此前渲染端一个入口都没接
//
// 钉三件事：①改期要带上该行原有的循环规则——repo.reschedule 不传 rule 会把 repeat_rule 写成 NULL，
// 静默把循环提醒降级成一次性；②一次性行要省略 repeatRule（schema 只接受对象或省略，传 null 会被拒）；
// ③失败时显示主进程给的原因原文（时间范围只有它知道），而不是笼统的「改期失败」。
import { describe, it, expect } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns, pocketaiCalls } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import type { ReminderRecord } from '../src/shared/types'

const PAST = new Date(2026, 9, 1, 9, 0, 0).getTime()

const rec = (over: Partial<ReminderRecord> = {}): ReminderRecord => ({
  id: 'r-1',
  text: '交周报',
  fireAt: PAST,
  status: 'fired',
  conversationId: null,
  createdAt: PAST - 86_400_000,
  ...over
})

const baseStubs = {
  onReminderFired: () => () => {},
  cancelReminder: () => ({ ok: true }),
  rescheduleNextReminder: () => ({ ok: true })
}

/** 打开提醒中心历史 tab；返回该 tab 的行数据由调用方给定 */
function mountHistory(rows: ReminderRecord[]): void {
  stubPocketai({
    ...baseStubs,
    listReminders: (scope?: string) => (scope === 'history' ? rows : []),
    rescheduleReminder: () => ({ ok: true }),
    updateReminder: () => ({ ok: true })
  })
  mountWithProviders(<RemindersModal onClose={() => {}} />)
  fireEvent.click(screen.getByText('历史'))
}

async function openRescheduleDialog(): Promise<void> {
  await screen.findByText('交周报')
  fireEvent.click(screen.getByText('改期'))
  await screen.findByText('改期并恢复')
}

function save(): void {
  fireEvent.click(screen.getByText('保存'))
}

function reschedulePayload(): Record<string, unknown> {
  const call = pocketaiCalls().find((c) => c.fn === 'rescheduleReminder')
  return (call?.args?.[0] ?? {}) as Record<string, unknown>
}

describe('历史行改期', () => {
  it('fired / missed / cancelled 三种终态行都给「改期」入口', async () => {
    mountHistory([rec({ id: 'a', status: 'fired' }), rec({ id: 'b', status: 'missed' }), rec({ id: 'c', status: 'cancelled' })])
    // 三行文案相同 ⇒ 只能 findAll（findByText 会因多命中直接抛错）
    await screen.findAllByText('交周报')
    expect(screen.getAllByText('改期')).toHaveLength(3)
  })

  it('弹窗预填一个未来时间，文本只读（RESCHEDULE 不动文案）', async () => {
    mountHistory([rec({ repeatRule: { kind: 'daily', intervalDays: 2 } })])
    await openRescheduleDialog()
    expect(document.querySelector('textarea')).toBeNull()
    const dt = document.querySelector('input[type=datetime-local]') as HTMLInputElement
    expect(new Date(dt.value).getTime()).toBeGreaterThan(Date.now() - 120_000)
    // 规则沿用原值，不用用户再选一遍
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('daily')
  })

  it('提交带上原循环规则——不传就会把循环提醒静默改成一次性', async () => {
    mountHistory([rec({ repeatRule: { kind: 'weekly', weekdays: [1, 3] } })])
    await openRescheduleDialog()
    save()
    await waitFor(() => expect(calledFns()).toContain('rescheduleReminder'))
    const p = reschedulePayload()
    expect(p.id).toBe('r-1')
    expect(p.repeatRule).toEqual({ kind: 'weekly', weekdays: [1, 3] })
    expect(Number(p.fireAt)).toBeGreaterThan(Date.now())
  })

  it('一次性行省略 repeatRule 字段（传 null 会被入参 schema 拒）', async () => {
    mountHistory([rec({ status: 'cancelled' })])
    await openRescheduleDialog()
    save()
    await waitFor(() => expect(calledFns()).toContain('rescheduleReminder'))
    expect('repeatRule' in reschedulePayload()).toBe(false)
  })

  it('主进程给了原因时显示原文，不再笼统报「改期失败」', async () => {
    stubPocketai({
      ...baseStubs,
      listReminders: (scope?: string) => (scope === 'history' ? [rec()] : []),
      rescheduleReminder: () => ({ ok: false, error: '提醒最远只能设置 30 天后' }),
      updateReminder: () => ({ ok: true })
    })
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    fireEvent.click(screen.getByText('历史'))
    await openRescheduleDialog()
    save()
    expect(await screen.findByText('提醒最远只能设置 30 天后')).toBeTruthy()
    expect(screen.queryByText('改期失败')).toBeNull()
  })

  it('待发 tab 的编辑仍走 UPDATE（本批只动历史行）', async () => {
    stubPocketai({
      ...baseStubs,
      listReminders: () => [rec({ id: 'p', status: 'pending', fireAt: Date.now() + 3_600_000 })],
      rescheduleReminder: () => ({ ok: true }),
      updateReminder: () => ({ ok: true })
    })
    mountWithProviders(<RemindersModal onClose={() => {}} />)
    await screen.findByText('交周报')
    fireEvent.click(screen.getByText('编辑'))
    fireEvent.click(await screen.findByText('保存'))
    await waitFor(() => expect(calledFns()).toContain('updateReminder'))
    expect(calledFns()).not.toContain('rescheduleReminder')
  })
})
