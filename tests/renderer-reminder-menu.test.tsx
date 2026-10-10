// @vitest-environment jsdom
// 「提醒我」预设浮层：时间点驱动四个定点项，循环项必须把 repeatRule 传出去，
// 且展开条改的星期/号数/间隔要同时反映到「标签文案」和「传出去的规则」上。
//
// 为什么单独测这一层：预设里的循环规则此前只到 onPick 就断了（onPick 只回传 fireAt），
// 用户点「每天 09:00」实际建出来的是一次性提醒；而星期/号数写死时，
// 标签写着「每周一」用户勾了别的日子也说谎——两头都得钉住。
import { describe, it, expect, vi } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { ReminderMenu } from '../src/renderer/src/components/ReminderMenu'

function mount(onPick: (fireAt: number, repeatRule?: unknown) => void) {
  stubPocketai({ setAppLanguage: () => Promise.resolve() })
  mountWithProviders(
    <ReminderMenu anchor={{ x: 120, y: 80 }} onPick={onPick} onClose={() => {}} />
  )
}

function pick(label: string): void {
  fireEvent.click(screen.getByText(label))
}

/** 三个循环项的设置按钮，顺序固定为 每 N 天 / 每周 / 每月 */
function caret(index: number): HTMLElement {
  return screen.getAllByLabelText('循环设置')[index] as HTMLElement
}

describe('ReminderMenu 预设项', () => {
  it('默认时间点 09:00 渲染在四个定点项上', () => {
    mount(vi.fn())
    expect(screen.getByText('下一个 09:00')).toBeTruthy()
    expect(screen.getByText('每天 09:00')).toBeTruthy()
    expect(screen.getByText('每周一 09:00')).toBeTruthy()
    expect(screen.getByText('每月 1 号 09:00')).toBeTruthy()
  })

  it('改时间点为 20:30：四个定点项标签同步跟随', () => {
    mount(vi.fn())
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '20:30' } })
    expect(screen.getByText('每天 20:30')).toBeTruthy()
    expect(screen.getByText('每周一 20:30')).toBeTruthy()
    expect(screen.getByText('下一个 20:30')).toBeTruthy()
  })

  it('点循环预设把对应 repeatRule 一起传出（不再退化成一次性提醒）', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '20:30' } })
    pick('每天 20:30')
    const [fireAt, rule] = onPick.mock.calls[0] as [number, unknown]
    expect(rule).toEqual({ kind: 'daily', intervalDays: 1 })
    const d = new Date(fireAt)
    expect(d.getHours()).toBe(20)
    expect(d.getMinutes()).toBe(30)

    pick('每周一 20:30')
    expect((onPick.mock.calls[1] as [number, unknown])[1]).toEqual({ kind: 'weekly', weekdays: [1] })

    pick('每月 1 号 20:30')
    expect((onPick.mock.calls[2] as [number, unknown])[1]).toEqual({ kind: 'monthly', dayOfMonth: 1 })
  })

  it('一次性项不带 repeatRule', () => {
    const onPick = vi.fn()
    mount(onPick)
    pick('下一个 09:00')
    expect(onPick.mock.calls[0]![1]).toBeUndefined()
  })

  it('相对时长项不受时间点与规则配置影响', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '20:30' } })
    const before = Date.now()
    pick('15 分钟后')
    const [fireAt, rule] = onPick.mock.calls[0] as [number, unknown]
    expect(rule).toBeUndefined()
    expect(fireAt - before).toBeGreaterThanOrEqual(14 * 60_000)
    expect(fireAt - before).toBeLessThanOrEqual(15 * 60_000 + 5_000)
  })

  it('时间点被清空时回落 09:00，不产出脏时间', () => {
    mount(vi.fn())
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '20:30' } })
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '' } })
    expect(screen.getByText('每天 09:00')).toBeTruthy()
  })

  it('自定义分钟仍走相对时间（无循环规则）', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '20:30' } })
    const number = document.querySelector('input[type=number]') as HTMLInputElement
    fireEvent.change(number, { target: { value: '90' } })
    fireEvent.click(screen.getByText('创建'))
    const [fireAt, rule] = onPick.mock.calls[0] as [number, unknown]
    expect(rule).toBeUndefined()
    expect(fireAt - Date.now()).toBeGreaterThan(80 * 60_000)
  })
})

describe('循环项的展开设置条', () => {
  it('每周项勾周三 → 标签与传出的规则一起变', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(1))
    // 多选语义：先加周三再去掉周一（直接去掉唯一选中项会被拦住）
    fireEvent.click(screen.getByText('周三'))
    fireEvent.click(screen.getByText('周一'))
    expect(screen.getByText('每周三 09:00')).toBeTruthy()
    pick('每周三 09:00')
    expect(onPick.mock.calls[0]![1]).toEqual({ kind: 'weekly', weekdays: [3] })
  })

  it('多选星期按分隔符拼进标签，规则带升序去重后的集合', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(1))
    fireEvent.click(screen.getByText('周五'))
    fireEvent.click(screen.getByText('周三'))
    fireEvent.click(screen.getByText('周一'))
    expect(screen.getByText('每周三、周五 09:00')).toBeTruthy()
    pick('每周三、周五 09:00')
    expect(onPick.mock.calls[0]![1]).toEqual({ kind: 'weekly', weekdays: [3, 5] })
  })

  it('取消最后一个勾选不生效（否则会建出永不触发的空 weekdays）', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(1))
    // 默认只有周一：再点两次周一（取消→再选）不应把规则清空
    fireEvent.click(screen.getByText('周一'))
    fireEvent.click(screen.getByText('周二'))
    fireEvent.click(screen.getByText('周二'))
    expect(screen.getByText('每周一 09:00')).toBeTruthy()
    pick('每周一 09:00')
    expect(onPick.mock.calls[0]![1]).toEqual({ kind: 'weekly', weekdays: [1] })
  })

  it('每月项改号数：标签跟着变，首触发也按新号数', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(2))
    fireEvent.change(screen.getByLabelText('每月几号'), { target: { value: '15' } })
    expect(screen.getByText('每月 15 号 09:00')).toBeTruthy()
    pick('每月 15 号 09:00')
    const [fireAt, rule] = onPick.mock.calls[0] as [number, unknown]
    expect(rule).toEqual({ kind: 'monthly', dayOfMonth: 15 })
    expect(new Date(fireAt).getDate()).toBe(15)
  })

  it('号数越界被夹住（写进规则的只能是 1–31）', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(2))
    fireEvent.change(screen.getByLabelText('每月几号'), { target: { value: '40' } })
    expect(screen.getByText('每月 31 号 09:00')).toBeTruthy()
    pick('每月 31 号 09:00')
    expect(onPick.mock.calls[0]![1]).toEqual({ kind: 'monthly', dayOfMonth: 31 })
  })

  it('每天项改间隔天数：不再是「每天」而是「每 N 天」', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(0))
    fireEvent.change(screen.getByLabelText('间隔天数'), { target: { value: '3' } })
    expect(screen.getByText('每 3 天 09:00')).toBeTruthy()
    pick('每 3 天 09:00')
    expect(onPick.mock.calls[0]![1]).toEqual({ kind: 'daily', intervalDays: 3 })
  })

  it('设置条与时间点互不干扰：20:30 + 周三 两者都体现在标签上', () => {
    const onPick = vi.fn()
    mount(onPick)
    fireEvent.click(caret(1))
    fireEvent.click(screen.getByText('周三'))
    fireEvent.click(screen.getByText('周一'))
    fireEvent.change(screen.getByLabelText('循环预设时间点'), { target: { value: '20:30' } })
    expect(screen.getByText('每周三 20:30')).toBeTruthy()
    pick('每周三 20:30')
    const [fireAt, rule] = onPick.mock.calls[0] as [number, unknown]
    expect(rule).toEqual({ kind: 'weekly', weekdays: [3] })
    expect(new Date(fireAt).getHours()).toBe(20)
    expect(new Date(fireAt).getMinutes()).toBe(30)
  })
})
