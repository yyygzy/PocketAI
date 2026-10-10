// @vitest-environment jsdom
// 提醒中心的循环徽标：待发与历史都要看得见规则
//
// 上一批修好了「循环预设其实建成一次性提醒」的链路 bug，但列表里循环与一次性长得一样，
// 用户无法确认自己建的到底是不是循环。这里钉住：pending 行渲染出规则徽标，且切到历史
// 重新拉取后徽标仍在（reload 走的是不同 scope 的返回数据）。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai, calledFns } from './helpers/renderer'
import { RemindersModal } from '../src/renderer/src/components/RemindersModal'
import type { ReminderRecord } from '../src/shared/types'

const rec = (over: Partial<ReminderRecord>): ReminderRecord => ({
  id: 'r-1',
  text: '交周报',
  fireAt: new Date(2026, 9, 12, 9, 0, 0).getTime(),
  status: 'pending',
  conversationId: null,
  createdAt: new Date(2026, 9, 10, 8, 0, 0).getTime(),
  ...over
})

function mount(rows: { pending: ReminderRecord[]; history: ReminderRecord[] }) {
  stubPocketai({
    listReminders: (scope?: string) => (scope === 'history' ? rows.history : rows.pending),
    onReminderFired: () => () => {},
    cancelReminder: () => ({ ok: true }),
    rescheduleNextReminder: () => ({ ok: true }),
    updateReminder: () => ({ ok: true })
  })
  mountWithProviders(<RemindersModal onClose={() => {}} />)
}

describe('提醒中心 · 循环徽标', () => {
  it('pending 行显示 daily / weekly / monthly 三种规则', async () => {
    mount({
      pending: [
        rec({ id: 'a', repeatRule: { kind: 'daily', intervalDays: 1 } }),
        rec({ id: 'b', repeatRule: { kind: 'weekly', weekdays: [3, 1] } }),
        rec({ id: 'c', repeatRule: { kind: 'monthly', dayOfMonth: 15 } })
      ],
      history: []
    })
    expect(await screen.findByText('每 1 天')).toBeTruthy()
    expect(screen.getByText('每周一、周三')).toBeTruthy()
    expect(screen.getByText('每月 15 号')).toBeTruthy()
  })

  it('一次性提醒不带徽标（没有规则就别装作会循环）', async () => {
    mount({ pending: [rec({ repeatRule: undefined })], history: [] })
    await screen.findByText('交周报')
    expect(screen.queryByText(/每 \d+ 天/)).toBeNull()
    expect(screen.queryByText(/每周/)).toBeNull()
    expect(screen.queryByText(/每月/)).toBeNull()
  })

  it('weekly 规则里全是脏星期值时不显示半截话', async () => {
    mount({ pending: [rec({ repeatRule: { kind: 'weekly', weekdays: [0, 9] } })], history: [] })
    await screen.findByText('交周报')
    expect(screen.queryByText('每')).toBeNull()
  })

  it('切到历史 tab 会按 history 重新拉取，循环徽标照常显示', async () => {
    mount({
      pending: [rec({ id: 'p' })],
      history: [rec({ id: 'h', status: 'fired', repeatRule: { kind: 'daily', intervalDays: 2 } })]
    })
    await screen.findByText('交周报')
    fireEvent.click(screen.getByText('历史'))
    await waitFor(() => expect(calledFns().filter((f) => f === 'listReminders')).toHaveLength(2))
    expect(await screen.findByText('每 2 天')).toBeTruthy()
  })

  it('missed 的循环提醒同时有徽标与「重新安排」入口', async () => {
    mount({
      pending: [],
      history: [rec({ id: 'm', status: 'missed', repeatRule: { kind: 'monthly', dayOfMonth: 1 } })]
    })
    fireEvent.click(screen.getByText('历史'))
    expect(await screen.findByText('重新安排')).toBeTruthy()
    expect(screen.getByText('每月 1 号')).toBeTruthy()
  })
})
