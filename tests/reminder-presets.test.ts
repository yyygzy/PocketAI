// 消息右键提醒预设纯函数测试：分钟夹取、时间点换算、循环配置、首触发时刻、文本清洗截断
import { describe, it, expect } from 'vitest'
import {
  clampReminderMinutes,
  presetMinuteOf,
  formatPresetMinute,
  normalizeRuleConfig,
  ruleFor,
  nextAtTime,
  nextWeekdayAt,
  nextWeekdayAnyAt,
  nextMonthDayAt,
  daysInMonth,
  buildReminderPresets,
  buildReminderText,
  reminderCreatedToastKey,
  DEFAULT_PRESET_MINUTE,
  DEFAULT_RULE_CONFIG
} from '../src/renderer/src/utils/reminder-presets'
import { MAX_REMINDER_MINUTES } from '../src/shared/schemas/reminder'
import { readFileSync } from 'node:fs'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const MIN = 60_000

describe('clampReminderMinutes', () => {
  it('夹到 1–43200 边界', () => {
    expect(clampReminderMinutes(0)).toBe(1)
    expect(clampReminderMinutes(-100)).toBe(1)
    expect(clampReminderMinutes(1)).toBe(1)
    expect(clampReminderMinutes(MAX_REMINDER_MINUTES)).toBe(MAX_REMINDER_MINUTES)
    expect(clampReminderMinutes(MAX_REMINDER_MINUTES + 5)).toBe(MAX_REMINDER_MINUTES)
  })
  it('小数向下取整；NaN/Infinity 归 1', () => {
    expect(clampReminderMinutes(12.9)).toBe(12)
    expect(clampReminderMinutes(Number.NaN)).toBe(1)
    expect(clampReminderMinutes(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('presetMinuteOf', () => {
  it('HH:MM → 当日分钟数', () => {
    expect(presetMinuteOf('09:00')).toBe(540)
    expect(presetMinuteOf('20:30')).toBe(1230)
    expect(presetMinuteOf('0:05')).toBe(5)
    expect(presetMinuteOf('23:59')).toBe(23 * 60 + 59)
  })
  it('非法/空缺一律回落 09:00（<input type=time> 清空或只打一半时不给脏值）', () => {
    expect(presetMinuteOf('')).toBe(DEFAULT_PRESET_MINUTE)
    expect(presetMinuteOf('9:')).toBe(DEFAULT_PRESET_MINUTE)
    expect(presetMinuteOf('abc')).toBe(DEFAULT_PRESET_MINUTE)
    expect(presetMinuteOf('24:00')).toBe(DEFAULT_PRESET_MINUTE)
    expect(presetMinuteOf('12:60')).toBe(DEFAULT_PRESET_MINUTE)
  })
})

describe('formatPresetMinute', () => {
  it('分钟数补零成 HH:MM（标签显示实际生效值，不是输入框原值）', () => {
    expect(formatPresetMinute(0)).toBe('00:00')
    expect(formatPresetMinute(540)).toBe('09:00')
    expect(formatPresetMinute(1230)).toBe('20:30')
    expect(formatPresetMinute(24 * 60 - 1)).toBe('23:59')
  })
  it('越界与脏值夹回当天范围，非有限值回落 09:00', () => {
    expect(formatPresetMinute(-5)).toBe('00:00')
    expect(formatPresetMinute(99 * 60)).toBe('23:59')
    expect(formatPresetMinute(Number.NaN)).toBe('09:00')
  })
})

describe('normalizeRuleConfig / ruleFor', () => {
  it('缺省等于旧的写死行为（每 1 天 / 周一 / 1 号）', () => {
    expect(normalizeRuleConfig()).toEqual({ intervalDays: 1, weekdays: [1], dayOfMonth: 1 })
    expect(normalizeRuleConfig()).toEqual(DEFAULT_RULE_CONFIG)
  })
  it('脏值夹回合法区间：间隔 1–365、号数 1–31、星期升序去重', () => {
    expect(normalizeRuleConfig({ intervalDays: 0, dayOfMonth: 99, weekdays: [5, 5, 2] })).toEqual({
      intervalDays: 1,
      dayOfMonth: 31,
      weekdays: [2, 5]
    })
    expect(normalizeRuleConfig({ intervalDays: 366 }).intervalDays).toBe(365)
    expect(normalizeRuleConfig({ intervalDays: 2.7 }).intervalDays).toBe(2)
  })
  it('星期全非法/空时回落 [1]——空数组会让这条循环提醒永不触发', () => {
    expect(normalizeRuleConfig({ weekdays: [0, 8, 2.5] }).weekdays).toEqual([1])
    expect(normalizeRuleConfig({ weekdays: [] }).weekdays).toEqual([1])
  })
  it('ruleFor 产出三种 kind 的规则', () => {
    const cfg = normalizeRuleConfig({ intervalDays: 3, weekdays: [3, 5], dayOfMonth: 15 })
    expect(ruleFor('daily', cfg)).toEqual({ kind: 'daily', intervalDays: 3 })
    expect(ruleFor('weekly', cfg)).toEqual({ kind: 'weekly', weekdays: [3, 5] })
    expect(ruleFor('monthly', cfg)).toEqual({ kind: 'monthly', dayOfMonth: 15 })
  })
})

describe('nextAtTime', () => {
  it('当天时间点未过 → 今天', () => {
    const now = new Date(2026, 9, 3, 8, 30, 0)
    const r = new Date(nextAtTime(now, 9 * 60))
    expect(r.getMonth()).toBe(9)
    expect(r.getDate()).toBe(3)
    expect(r.getHours()).toBe(9)
    expect(r.getMinutes()).toBe(0)
  })
  it('已过 / 正好到点 → 次日同一时间点；非 09:00 的自定义点同样生效', () => {
    const late = new Date(2026, 9, 3, 10, 0, 0)
    expect(new Date(nextAtTime(late, 9 * 60)).getDate()).toBe(4)
    const sharp = new Date(2026, 9, 3, 9, 0, 0)
    expect(new Date(nextAtTime(sharp, 9 * 60)).getDate()).toBe(4)
    const r2 = new Date(nextAtTime(late, 20 * 60 + 30))
    expect(r2.getDate()).toBe(3)
    expect(r2.getHours()).toBe(20)
    expect(r2.getMinutes()).toBe(30)
  })
})

describe('nextWeekdayAt / nextWeekdayAnyAt', () => {
  it('今天就是周一且未到点 → 今天；已过 → 下周一', () => {
    const before = new Date(2026, 9, 5, 8, 0, 0) // 2026-10-05 是周一
    const r1 = new Date(nextWeekdayAt(before, 1, 9 * 60))
    expect(r1.getDay()).toBe(1)
    expect(r1.getDate()).toBe(5)
    const r2 = new Date(nextWeekdayAt(new Date(2026, 9, 5, 9, 30, 0), 1, 9 * 60))
    expect(r2.getDay()).toBe(1)
    expect(r2.getDate()).toBe(12)
  })
  it('从周五顺延到下一个周一，并保留自定义时间点', () => {
    const fri = new Date(2026, 9, 2, 12, 0, 0)
    const r = new Date(nextWeekdayAt(fri, 1, 20 * 60 + 30))
    expect(r.getDay()).toBe(1)
    expect(r.getDate()).toBe(5)
    expect(r.getHours()).toBe(20)
    expect(r.getMinutes()).toBe(30)
  })
  it('多选星期取最近的那个（周五晚上勾周三+周五，下一次应在下周三之前的周三）', () => {
    // 2026-10-02 是周五，21:00 已过当天 20:30 ⇒ 候选是 10/7(三) 与 10/9(五)，取 10/7
    const fri = new Date(2026, 9, 2, 21, 0, 0)
    const r = new Date(nextWeekdayAnyAt(fri, [3, 5], 20 * 60 + 30))
    expect(r.getDay()).toBe(3)
    expect(r.getDate()).toBe(7)
    expect(r.getHours()).toBe(20)
    expect(r.getMinutes()).toBe(30)
  })
  it('今天已轮到其中之一但时刻已过 → 顺延到下一个命中的日子', () => {
    const wedNoon = new Date(2026, 9, 7, 12, 0, 0)
    const r = new Date(nextWeekdayAnyAt(wedNoon, [3, 5], 9 * 60))
    expect(r.getDay()).toBe(5)
    expect(r.getDate()).toBe(9)
  })
  it('空/非法选择回落周一，不返回 NaN', () => {
    const r = new Date(nextWeekdayAnyAt(new Date(2026, 9, 2, 12, 0, 0), [0, 9]))
    expect(r.getDay()).toBe(1)
  })
})

describe('nextMonthDayAt', () => {
  it('本月这天还没过 → 本月；已过 → 下月', () => {
    const early = new Date(2026, 9, 1, 8, 0, 0)
    const r1 = new Date(nextMonthDayAt(early, 1, 9 * 60))
    expect(r1.getMonth()).toBe(9)
    expect(r1.getDate()).toBe(1)
    const r2 = new Date(nextMonthDayAt(new Date(2026, 9, 1, 9, 30, 0), 1, 9 * 60))
    expect(r2.getMonth()).toBe(10)
    expect(r2.getDate()).toBe(1)
  })
  it('该月没有这天时回落到当月最后一天（与主进程重排口径一致）', () => {
    const apr = new Date(2026, 3, 10, 12, 0, 0)
    const r = new Date(nextMonthDayAt(apr, 31, 9 * 60))
    expect(r.getMonth()).toBe(3)
    expect(r.getDate()).toBe(30) // 4 月只有 30 天
    // 1/31 已过 1/30 ⇒ 落到 2 月，2 月没有 30 号 ⇒ 回落到当月最后一天
    const jan = new Date(2026, 0, 31, 12, 0, 0)
    const r2 = new Date(nextMonthDayAt(jan, 30, 9 * 60))
    expect(r2.getMonth()).toBe(1)
    expect(r2.getDate()).toBe(28) // 2026 非闰年
    // 本月还有这天时不该跳到下月
    const earlyJan = new Date(2026, 0, 10, 12, 0, 0)
    expect(new Date(nextMonthDayAt(earlyJan, 30, 9 * 60)).getDate()).toBe(30)
  })
  it('当月已过目标日时跳下月，下月同样做天数回落', () => {
    const may31 = new Date(2026, 4, 31, 23, 0, 0)
    const r = new Date(nextMonthDayAt(may31, 31, 9 * 60))
    expect(r.getMonth()).toBe(5)
    expect(r.getDate()).toBe(30) // 6 月没有 31 号
  })
  it('本月没过就取本月，跨年取下月，时间点保留', () => {
    expect(daysInMonth(2026, 1)).toBe(28)
    expect(daysInMonth(2024, 1)).toBe(29)
    const decEarly = new Date(2026, 11, 15, 12, 0, 0)
    expect(new Date(nextMonthDayAt(decEarly, 20, 9 * 60)).getMonth()).toBe(11)
    const dec = new Date(2026, 11, 25, 12, 0, 0)
    const r = new Date(nextMonthDayAt(dec, 20, 21 * 60 + 30))
    expect(r.getFullYear()).toBe(2027)
    expect(r.getMonth()).toBe(0)
    expect(r.getDate()).toBe(20)
    expect(r.getHours()).toBe(21)
    expect(r.getMinutes()).toBe(30)
  })
})

describe('buildReminderPresets', () => {
  it('7 个预设 key 完整，缺省配置仍是「每 1 天 / 周一 / 1 号」', () => {
    const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
    const ps = buildReminderPresets(now)
    expect(ps.map((p) => p.key)).toEqual([
      'in15m', 'in1h', 'in3h', 'nextAt', 'everyDay', 'everyWeek', 'everyMonth'
    ])
    expect(ps[0]!.fireAt).toBe(now + 15 * MIN)
    expect(ps[1]!.fireAt).toBe(now + 60 * MIN)
    expect(ps[2]!.fireAt).toBe(now + 180 * MIN)
    expect(new Date(ps[3]!.fireAt).getHours()).toBe(9)
    expect(ps[4]!.repeatRule).toEqual({ kind: 'daily', intervalDays: 1 })
    expect(ps[5]!.repeatRule).toEqual({ kind: 'weekly', weekdays: [1] })
    expect(ps[6]!.repeatRule).toEqual({ kind: 'monthly', dayOfMonth: 1 })
    expect(ps[4]!.fireAt).toBe(ps[3]!.fireAt) // everyDay 起点同 nextAt
    expect(new Date(ps[5]!.fireAt).getDay()).toBe(1)
    expect(new Date(ps[6]!.fireAt).getDate()).toBe(1)
    for (const p of ps) {
      expect(p.fireAt).toBeGreaterThan(now)
      expect(p.fireAt).toBeLessThanOrEqual(now + MAX_REMINDER_MINUTES * MIN)
    }
  })

  it('配置驱动的循环项：规则与首触发时间跟着一起变', () => {
    const now = new Date(2026, 9, 2, 12, 0, 0).getTime() // 周五
    const cfg = normalizeRuleConfig({ intervalDays: 3, weekdays: [3, 5], dayOfMonth: 15 })
    const ps = buildReminderPresets(now, 20 * 60 + 30, cfg)
    const byKey = Object.fromEntries(ps.map((p) => [p.key, p]))
    expect(byKey.everyDay!.repeatRule).toEqual({ kind: 'daily', intervalDays: 3 })
    expect(byKey.everyWeek!.repeatRule).toEqual({ kind: 'weekly', weekdays: [3, 5] })
    expect(byKey.everyMonth!.repeatRule).toEqual({ kind: 'monthly', dayOfMonth: 15 })
    // 周五 12:00 时 20:30 还没到，当天就是最近命中
    expect(new Date(byKey.everyWeek!.fireAt).getDay()).toBe(5)
    expect(new Date(byKey.everyMonth!.fireAt).getDate()).toBe(15)
    for (const p of [byKey.everyDay!, byKey.everyWeek!, byKey.everyMonth!]) {
      expect(new Date(p.fireAt).getHours()).toBe(20)
      expect(new Date(p.fireAt).getMinutes()).toBe(30)
    }
  })

  it('时间点参数被四个定点项共用（含分钟，不再固定 09:00）', () => {
    const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
    const ps = buildReminderPresets(now, 20 * 60 + 30)
    for (const p of ps.slice(3)) {
      const d = new Date(p.fireAt)
      expect(d.getHours()).toBe(20)
      expect(d.getMinutes()).toBe(30)
      expect(d.getSeconds()).toBe(0)
    }
    expect(ps[1]!.fireAt).toBe(now + 60 * MIN) // 相对时长项不受影响
  })

  it('脏配置不污染一次性项与相对时长项，循环项回落合法值', () => {
    const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
    const ps = buildReminderPresets(now, 540, { intervalDays: Number.NaN, weekdays: [], dayOfMonth: -4 })
    expect(ps[0]!.fireAt).toBe(now + 15 * MIN)
    expect(ps[3]!.repeatRule).toBeUndefined()
    expect(ps[5]!.repeatRule).toEqual({ kind: 'weekly', weekdays: [1] })
    expect(ps[6]!.repeatRule).toEqual({ kind: 'monthly', dayOfMonth: 1 })
  })

  it('缺省时间点等于显式 09:00 的旧行为', () => {
    const now = new Date(2026, 9, 3, 12, 0, 0).getTime()
    expect(buildReminderPresets(now).slice(3).map((p) => p.fireAt)).toEqual(
      buildReminderPresets(now, DEFAULT_PRESET_MINUTE).slice(3).map((p) => p.fireAt)
    )
  })
})

describe('buildReminderText', () => {
  it('折叠空白与去 markdown 符号', () => {
    expect(buildReminderText('# 标题\n\n正文  **粗体**  [链接](u)')).toBe('标题 正文 粗体 链接')
    expect(buildReminderText('  多行\n  文本 \t ')).toBe('多行 文本')
  })
  it('代码块整体折叠为空格', () => {
    expect(buildReminderText('前\n```js\nconst x=1\n```\n后')).toBe('前 后')
  })
  it('截断到 200 字', () => {
    expect(buildReminderText('a'.repeat(500))).toHaveLength(200)
  })
  it('纯空白返回空串（供调用方提示无文本）', () => {
    expect(buildReminderText('   \n\t')).toBe('')
  })
})
// —— V4-Iter-172：B24 对账现查的那条零覆盖 ——
// 「已设置循环提醒：… 起」这句 toast 此前全仓 tests 里 0 引用；而对话与 Agent 两处调用点
// 还各自手抄了一遍三元 ⇒ 正是 V4-Iter-117 那族"改一处等于把 bug 挪个地方"的形状。
describe('创建提醒的 toast 选键（reminderCreatedToastKey）', () => {
  it('带循环规则与一次性是**两句话**，各按自己的键走', () => {
    expect(reminderCreatedToastKey(null)).toBe('reminder.menu.created')
    expect(reminderCreatedToastKey(undefined)).toBe('reminder.menu.created')
    expect(reminderCreatedToastKey({ kind: 'daily', intervalDays: 1 })).toBe('reminder.menu.createdRepeat')
    expect(reminderCreatedToastKey({ kind: 'monthly', dayOfMonth: 31 })).toBe('reminder.menu.createdRepeat')
  })

  it('两把键在四本字典里都在、都带 {time} 插值、且两句互不相同', () => {
    for (const raw of [zh, en, ja, ko]) {
      const dict = raw as Record<string, string>
      const one = dict['reminder.menu.created'] ?? ''
      const rep = dict['reminder.menu.createdRepeat'] ?? ''
      expect(one, '一次性那句不能缺').toBeTruthy()
      expect(rep, '循环那句不能缺').toBeTruthy()
      expect(rep).toContain('{time}')
      expect(one).toContain('{time}')
      expect(rep).not.toBe(one)
    }
  })

  it('循环那句真的说了"循环"这件事（别让它在某语里退化成同一句话）', () => {
    const zhRep = (zh as Record<string, string>)['reminder.menu.createdRepeat'] ?? ''
    const enRep = (en as Record<string, string>)['reminder.menu.createdRepeat'] ?? ''
    expect(zhRep).toContain('循环')
    expect(enRep.toLowerCase()).toContain('recurring')
  })

  it('两处调用点都走这个函数，源码里不再留手抄的三元', () => {
    for (const f of [
      'src/renderer/src/modules/chat/ChatModule.tsx',
      'src/renderer/src/modules/agent/chat/AgentPanel.tsx'
    ]) {
      const src = readFileSync(f, 'utf8') as string
      expect(src, f + ' 应当改用 reminderCreatedToastKey').toContain('t(reminderCreatedToastKey(repeatRule)')
      expect(src, f + " 里不许再留手抄的三元").not.toContain("repeatRule ? 'reminder.menu.createdRepeat'")
    }
  })
})
