// calendar-ics 日历解析测试
//
// 覆盖 src/main/tools/calendar-ics.ts 的纯解析逻辑：
// - unescapeText：iCalendar 文本反转义（\n \, \; \\）
// - parseIcsDate：DTSTART/DTEND 解析（DATE 全天 / DATETIME 本地 / DATETIME UTC(Z) / 非法值）
// - parseIcs：ICS 全文解析（续行折叠、VEVENT 块、字段提取、CANCELLED 跳过）
// - fmtLocal：本地日期格式化（零点 time=null）
// - rangeWindow：时间窗口（today/tomorrow/this-week/upcoming/all）
//
// 策略：纯函数直接 import，无 mock。rangeWindow 依赖系统时间，断言结构与边界。
import { describe, it, expect, vi } from 'vitest'

// 被测纯函数不依赖 appConfigRepo，但模块顶层 import 会触发 DB→electron 链，
// vitest 下 require('electron') 返回路径字符串，故 mock 掉避免初始化崩溃。
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} }
}))

import {
  unescapeText,
  parseIcsDate,
  parseIcs,
  fmtLocal,
  rangeWindow
} from '../src/main/tools/calendar-ics'

describe('unescapeText — iCalendar 文本反转义', () => {
  it('\\n → 换行', () => {
    expect(unescapeText('line1\\nline2')).toBe('line1\nline2')
  })
  it('\\N 大写也转义', () => {
    expect(unescapeText('a\\Nb')).toBe('a\nb')
  })
  it('\\, → 逗号', () => {
    expect(unescapeText('a\\,b')).toBe('a,b')
  })
  it('\\; → 分号', () => {
    expect(unescapeText('a\\;b')).toBe('a;b')
  })
  it('\\\\ → 反斜杠', () => {
    expect(unescapeText('a\\\\b')).toBe('a\\b')
  })
  it('无转义 → 原样', () => {
    expect(unescapeText('hello world')).toBe('hello world')
  })
  it('组合转义', () => {
    expect(unescapeText('a\\,b\\;c\\\\d\\ne')).toBe('a,b;c\\d\ne')
  })
})

describe('parseIcsDate — 日期时间解析', () => {
  it('DATE 格式（8 位）→ 全天事件，本地零点', () => {
    const r = parseIcsDate('20260924', '')
    expect(r?.allDay).toBe(true)
    expect(r?.date.getFullYear()).toBe(2026)
    expect(r?.date.getMonth()).toBe(8) // 9 月
    expect(r?.date.getDate()).toBe(24)
  })

  it('DATE 月份非法 → null', () => {
    expect(parseIcsDate('20261301', '')).toBeNull()
  })

  it('DATE 日期非法 → null', () => {
    expect(parseIcsDate('20260100', '')).toBeNull()
    expect(parseIcsDate('20260132', '')).toBeNull()
  })

  it('DATETIME 本地时间 → 本地 Date，非全天', () => {
    const r = parseIcsDate('20260924T143000', '')
    expect(r?.allDay).toBe(false)
    expect(r?.date.getHours()).toBe(14)
    expect(r?.date.getMinutes()).toBe(30)
  })

  it('DATETIME UTC（Z 后缀）→ UTC 转本地', () => {
    const r = parseIcsDate('20260924T143000Z', '')
    expect(r?.allDay).toBe(false)
    // UTC 14:30 = 本地 14:30 + 时区偏移
    expect(r?.date.getUTCHours()).toBe(14)
    expect(r?.date.getUTCMinutes()).toBe(30)
  })

  it('TZID 参数被忽略，按本地字面时间', () => {
    const r = parseIcsDate('20260924T100000', 'TZID=America/New_York')
    expect(r?.date.getHours()).toBe(10)
  })

  it('非法格式 → null', () => {
    expect(parseIcsDate('not-a-date', '')).toBeNull()
    expect(parseIcsDate('', '')).toBeNull()
    expect(parseIcsDate('2026-09-24', '')).toBeNull()
  })

  it('前后空白自动 trim', () => {
    const r = parseIcsDate('  20260924  ', '')
    expect(r?.allDay).toBe(true)
  })
})

describe('parseIcs — ICS 全文解析', () => {
  it('基础 VEVENT → 解析出 start/summary', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'DTEND:20260924T110000',
      'SUMMARY:Team Meeting',
      'END:VEVENT',
      'END:VCALENDAR'
    ].join('\r\n')
    const events = parseIcs(ics)
    expect(events).toHaveLength(1)
    expect(events[0]!.summary).toBe('Team Meeting')
    expect(events[0]!.start.getHours()).toBe(10)
    expect(events[0]!.end?.getHours()).toBe(11)
    expect(events[0]!.allDay).toBe(false)
  })

  it('全天事件 → allDay=true', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART;VALUE=DATE:20260924',
      'SUMMARY:Birthday',
      'END:VEVENT'
    ].join('\n')
    const events = parseIcs(ics)
    expect(events[0]!.allDay).toBe(true)
  })

  it('续行折叠（空格/Tab 开头拼回上一行，折叠字符被移除）', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'SUMMARY:This is a very',
      ' long summary that',
      '\tspans multiple lines',
      'END:VEVENT'
    ].join('\n')
    const events = parseIcs(ics)
    expect(events[0]!.summary).toBe('This is a verylong summary thatspans multiple lines')
  })

  it('LOCATION / DESCRIPTION 提取，无则 null', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'SUMMARY:Meeting',
      'LOCATION:Room 404',
      'DESCRIPTION:Bring laptop',
      'END:VEVENT'
    ].join('\n')
    const ev = parseIcs(ics)[0]!
    expect(ev.location).toBe('Room 404')
    expect(ev.description).toBe('Bring laptop')
  })

  it('无 LOCATION/DESCRIPTION → null', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'SUMMARY:Meeting',
      'END:VEVENT'
    ].join('\n')
    const ev = parseIcs(ics)[0]!
    expect(ev.location).toBeNull()
    expect(ev.description).toBeNull()
  })

  it('STATUS:CANCELLED → 跳过', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'SUMMARY:Cancelled Event',
      'STATUS:CANCELLED',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART:20260925T100000',
      'SUMMARY:Active Event',
      'END:VEVENT'
    ].join('\n')
    const events = parseIcs(ics)
    expect(events).toHaveLength(1)
    expect(events[0]!.summary).toBe('Active Event')
  })

  it('无 DTSTART → 跳过', () => {
    const ics = [
      'BEGIN:VEVENT',
      'SUMMARY:No Date',
      'END:VEVENT'
    ].join('\n')
    expect(parseIcs(ics)).toHaveLength(0)
  })

  it('多个事件 → 全部解析', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'SUMMARY:Event 1',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART:20260925T100000',
      'SUMMARY:Event 2',
      'END:VEVENT',
      'BEGIN:VEVENT',
      'DTSTART:20260926T100000',
      'SUMMARY:Event 3',
      'END:VEVENT'
    ].join('\n')
    const events = parseIcs(ics)
    expect(events).toHaveLength(3)
    expect(events.map((e) => e.summary)).toEqual(['Event 1', 'Event 2', 'Event 3'])
  })

  it('无 SUMMARY → 默认 (无标题)', () => {
    const ics = [
      'BEGIN:VEVENT',
      'DTSTART:20260924T100000',
      'END:VEVENT'
    ].join('\n')
    expect(parseIcs(ics)[0]!.summary).toBe('(无标题)')
  })

  it('属性名大小写不敏感', () => {
    const ics = [
      'BEGIN:VEVENT',
      'dtstart:20260924T100000',
      'summary:lowercase',
      'END:VEVENT'
    ].join('\n')
    const events = parseIcs(ics)
    expect(events).toHaveLength(1)
    expect(events[0]!.summary).toBe('lowercase')
  })

  it('空内容 → 空数组', () => {
    expect(parseIcs('')).toEqual([])
  })
})

describe('fmtLocal — 本地日期格式化', () => {
  it('非零点 → date + HH:MM', () => {
    const d = new Date(2026, 8, 24, 14, 30)
    expect(fmtLocal(d)).toEqual({ date: '2026-09-24', time: '14:30' })
  })

  it('零点（00:00）→ time 为 null（全天事件）', () => {
    const d = new Date(2026, 0, 1, 0, 0)
    expect(fmtLocal(d)).toEqual({ date: '2026-01-01', time: null })
  })

  it('月/日补零', () => {
    const d = new Date(2026, 0, 5, 9, 5)
    expect(fmtLocal(d)).toEqual({ date: '2026-01-05', time: '09:05' })
  })
})

describe('rangeWindow — 时间窗口', () => {
  const DAY = 24 * 60 * 60 * 1000

  it('today → 今天 00:00 到明天 00:00', () => {
    const w = rangeWindow('today')
    expect(w.label).toBe('今天')
    const now = new Date()
    expect(w.from.getFullYear()).toBe(now.getFullYear())
    expect(w.from.getMonth()).toBe(now.getMonth())
    expect(w.from.getDate()).toBe(now.getDate())
    expect(w.from.getHours()).toBe(0)
    expect(w.from.getMinutes()).toBe(0)
    expect(w.to).not.toBeNull()
    expect(w.to!.getTime() - w.from.getTime()).toBe(DAY)
  })

  it('tomorrow → 明天 00:00 到后天 00:00', () => {
    const w = rangeWindow('tomorrow')
    expect(w.label).toBe('明天')
    const today = rangeWindow('today')
    expect(w.from.getTime()).toBe(today.to!.getTime())
    expect(w.to!.getTime() - w.from.getTime()).toBe(DAY)
  })

  it('this-week → 周一 00:00 到下周一 00:00（7 天）', () => {
    const w = rangeWindow('this-week')
    expect(w.label).toBe('本周')
    expect(w.from.getDay()).toBe(1) // 周一
    expect(w.to).not.toBeNull()
    expect(w.to!.getDay()).toBe(1)
    expect(w.to!.getTime() - w.from.getTime()).toBe(7 * DAY)
  })

  it('upcoming → 现在起 30 天', () => {
    const before = Date.now()
    const w = rangeWindow('upcoming')
    const after = Date.now()
    expect(w.label).toBe('未来30天')
    expect(w.from.getTime()).toBeGreaterThanOrEqual(before)
    expect(w.from.getTime()).toBeLessThanOrEqual(after)
    expect(w.to).not.toBeNull()
    expect(w.to!.getTime() - w.from.getTime()).toBe(30 * DAY)
  })

  it('all → 1970-01-01 起，无上限', () => {
    const w = rangeWindow('all')
    expect(w.label).toBe('全部')
    expect(w.from.getTime()).toBe(0)
    expect(w.to).toBeNull()
  })

  it('未知 range → 回退 all', () => {
    const w = rangeWindow('unknown-range')
    expect(w.label).toBe('全部')
    expect(w.to).toBeNull()
  })
})
