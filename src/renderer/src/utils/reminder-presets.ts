// 消息右键「提醒我」预设纯函数（时间换算在渲染端按用户本地时区；主进程仍二次校验范围）。
import { MAX_REMINDER_MINUTES } from '../../../shared/schemas/reminder'
import { normalizeWeekdays } from '../../../shared/reminder-rule'
import type { ReminderRepeatRule } from '../../../shared/types'

export type ReminderPresetKey =
  | 'in15m'
  | 'in1h'
  | 'in3h'
  | 'nextAt'
  | 'everyDay'
  | 'everyWeek'
  | 'everyMonth'

export interface ReminderPreset {
  key: ReminderPresetKey
  fireAt: number
  /** 循环规则（无=一次性） */
  repeatRule?: ReminderRepeatRule
}

const MINUTE = 60_000

/** 预设的默认时间点：09:00（菜单里的时间输入未填/非法时回落） */
export const DEFAULT_PRESET_MINUTE = 9 * 60
/** 每周预设的默认星期：周一（JS getDay 周日=0；本项目规则约定周一=1 … 周日=7） */
export const PRESET_WEEKDAY = 1
/** 每月预设的默认号数 */
export const PRESET_DAY_OF_MONTH = 1
export const INTERVAL_DAYS_MIN = 1
export const INTERVAL_DAYS_MAX = 365
export const DAY_OF_MONTH_MIN = 1
export const DAY_OF_MONTH_MAX = 31

/** 三个循环预设的可配置项（菜单展开条管的就是这三样） */
export interface PresetRuleConfig {
  intervalDays: number
  weekdays: number[]
  dayOfMonth: number
}

export const DEFAULT_RULE_CONFIG: PresetRuleConfig = {
  intervalDays: 1,
  weekdays: [PRESET_WEEKDAY],
  dayOfMonth: PRESET_DAY_OF_MONTH
}

/** 自定义分钟夹取到 1–43200（30 天），非有限值/NaN 归 1 */
export function clampReminderMinutes(v: number): number {
  if (!Number.isFinite(v)) return 1
  return Math.min(MAX_REMINDER_MINUTES, Math.max(1, Math.floor(v)))
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(v)) return fallback
  return Math.min(max, Math.max(min, Math.floor(v)))
}

/**
 * 脏值/越界一律夹回合法区间；星期全非法时回落默认周一——
 * schema 要求 weekdays 至少 1 个，给空数组等于建出一条永不触发的循环提醒。
 */
export function normalizeRuleConfig(cfg: Partial<PresetRuleConfig> = {}): PresetRuleConfig {
  const weekdays = normalizeWeekdays(cfg.weekdays ?? DEFAULT_RULE_CONFIG.weekdays)
  return {
    intervalDays: clampInt(
      cfg.intervalDays ?? DEFAULT_RULE_CONFIG.intervalDays,
      INTERVAL_DAYS_MIN,
      INTERVAL_DAYS_MAX,
      DEFAULT_RULE_CONFIG.intervalDays
    ),
    weekdays: weekdays.length > 0 ? weekdays : [PRESET_WEEKDAY],
    dayOfMonth: clampInt(
      cfg.dayOfMonth ?? DEFAULT_RULE_CONFIG.dayOfMonth,
      DAY_OF_MONTH_MIN,
      DAY_OF_MONTH_MAX,
      PRESET_DAY_OF_MONTH
    )
  }
}

/** 配置 → 循环规则（与 schemas/reminder.ts 的三种 kind 一一对应） */
export function ruleFor(kind: 'daily' | 'weekly' | 'monthly', cfg: PresetRuleConfig): ReminderRepeatRule {
  const safe = normalizeRuleConfig(cfg)
  if (kind === 'daily') return { kind: 'daily', intervalDays: safe.intervalDays }
  if (kind === 'monthly') return { kind: 'monthly', dayOfMonth: safe.dayOfMonth }
  return { kind: 'weekly', weekdays: safe.weekdays }
}

/** 'HH:MM'（<input type=time> 的值）→ 当日分钟数；缺分秒或非法一律回落 09:00 */
export function presetMinuteOf(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return DEFAULT_PRESET_MINUTE
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min) || h > 23 || min > 59) return DEFAULT_PRESET_MINUTE
  return h * 60 + min
}

/** 当日分钟数 → 'HH:MM'（预设标签显示的是实际生效时间点，而非输入框原值） */
export function formatPresetMinute(atMinute: number): string {
  const safe = Number.isFinite(atMinute)
    ? Math.max(0, Math.min(24 * 60 - 1, Math.floor(atMinute)))
    : DEFAULT_PRESET_MINUTE
  const h = Math.floor(safe / 60)
  const m = safe % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function atLocalTime(d: Date, atMinute: number): Date {
  d.setHours(Math.floor(atMinute / 60), atMinute % 60, 0, 0)
  return d
}

/** 下一个本地时间 atMinute 的 epoch：该时刻已过（含正好相等，留出创建耗时）则取明天 */
export function nextAtTime(now: Date = new Date(), atMinute = DEFAULT_PRESET_MINUTE): number {
  const d = atLocalTime(new Date(now), atMinute)
  if (d.getTime() <= now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** 下一个本地时间 周 weekday atMinute 的 epoch：今天已轮到且未到点取今日，否则顺延 */
export function nextWeekdayAt(
  now: Date = new Date(),
  weekday = PRESET_WEEKDAY,
  atMinute = DEFAULT_PRESET_MINUTE
): number {
  const d = atLocalTime(new Date(now), atMinute)
  const day = d.getDay()
  const offset = day === weekday ? (d.getTime() <= now.getTime() ? 7 : 0) : ((7 + weekday - day) % 7)
  d.setDate(d.getDate() + offset)
  return d.getTime()
}

/** 勾了多个星期时取其中最近的那个到点时刻（勾周三和周五，第一次该在周三响） */
export function nextWeekdayAnyAt(
  now: Date = new Date(),
  weekdays: readonly number[] = [PRESET_WEEKDAY],
  atMinute = DEFAULT_PRESET_MINUTE
): number {
  const days = normalizeWeekdays(weekdays)
  const list = days.length > 0 ? days : [PRESET_WEEKDAY]
  return Math.min(...list.map((wd) => nextWeekdayAt(now, wd, atMinute)))
}

/** 当月天数（monthIndex 为 0–11） */
export function daysInMonth(year: number, monthIndex: number): number {
  return new Date(year, monthIndex + 1, 0).getDate()
}

/**
 * 给定日期所在月的 day 号那个时刻；该月没有这天（2 月 30 号、4 月 31 号）回落到当月最后一天。
 * 回落口径必须与主进程 computeNextFireAt 一致，否则首触发与后续重排会错开一天。
 */
function monthDayAt(now: Date, day: number, atMinute: number): number {
  const d = atLocalTime(new Date(now), atMinute)
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())))
  return d.getTime()
}

/** 下一个本地时间 每月 day 号 atMinute 的 epoch：本月这天还没过取本月，否则取下月 */
export function nextMonthDayAt(
  now: Date = new Date(),
  day = PRESET_DAY_OF_MONTH,
  atMinute = DEFAULT_PRESET_MINUTE
): number {
  const thisMonth = monthDayAt(now, day, atMinute)
  if (thisMonth > now.getTime()) return thisMonth
  // 先跳回 1 号再加月：1/31 直接 +1 月会被 JS 溢出到 3 月初
  const nm = new Date(now)
  nm.setDate(1)
  nm.setMonth(nm.getMonth() + 1)
  return monthDayAt(nm, day, atMinute)
}

/**
 * 7 个预设：15 分钟 / 1 小时 / 3 小时（相对）+ 下一个 atMinute（一次性）+ 三个循环项。
 * 四个定点项共用同一 atMinute；三个循环项另由 cfg（每 N 天 / 周几 / 几号）驱动。
 */
export function buildReminderPresets(
  now: number = Date.now(),
  atMinute: number = DEFAULT_PRESET_MINUTE,
  cfg: PresetRuleConfig = DEFAULT_RULE_CONFIG
): ReminderPreset[] {
  const d = new Date(now)
  const safe = normalizeRuleConfig(cfg)
  return [
    { key: 'in15m', fireAt: now + 15 * MINUTE },
    { key: 'in1h', fireAt: now + 60 * MINUTE },
    { key: 'in3h', fireAt: now + 180 * MINUTE },
    { key: 'nextAt', fireAt: nextAtTime(d, atMinute) },
    { key: 'everyDay', fireAt: nextAtTime(d, atMinute), repeatRule: ruleFor('daily', safe) },
    {
      key: 'everyWeek',
      fireAt: nextWeekdayAnyAt(d, safe.weekdays, atMinute),
      repeatRule: ruleFor('weekly', safe)
    },
    {
      key: 'everyMonth',
      fireAt: nextMonthDayAt(d, safe.dayOfMonth, atMinute),
      repeatRule: ruleFor('monthly', safe)
    }
  ]
}

/** 从消息正文生成提醒文本：折叠空白、去 markdown 标记、截 200 字 */
export function buildReminderText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // 图片：保留 alt 文本
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接：保留链接文字、丢 URL
    .replace(/[#>*`_~\-[\]()!]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
}
/**
 * 创建成功的 toast 用哪把字典键：循环提醒与一次性提醒是**两句话**
 * （「已设置循环提醒：… 起」vs「已设置提醒：…」），Agent 与对话两处调用点共用本函数，
 * 别再各抄一遍三元（V4-Iter-117 那族"改一处等于把 bug 挪个地方"）。
 */
export function reminderCreatedToastKey(repeatRule?: ReminderRepeatRule | null):
  'reminder.menu.createdRepeat' | 'reminder.menu.created' {
  return repeatRule ? 'reminder.menu.createdRepeat' : 'reminder.menu.created'
}
