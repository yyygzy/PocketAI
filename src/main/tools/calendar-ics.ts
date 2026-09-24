// calendar.read 工具：读取本地 .ics（iCalendar）日程文件
//
// - 零依赖轻量解析：RFC5545 unfold（续行）→ VEVENT 块 → DTSTART/DTEND/SUMMARY 等
// - 时区策略：带 Z 后缀按 UTC 转本地；TZID 忽略时区名、按字面时间作本地时间
//  （国内场景日历多为本地时区导出，够用；跨时区日程以 Z 格式为准）
// - RRULE 重复事件 v1 不展开（只返回原定时刻），STATUS:CANCELLED 跳过
// - 配置存 app_config：agent.calendar_enabled / agent.calendar_ics_paths（JSON 数组）
import fs from 'node:fs'
import type { BuiltinTool } from './builtin'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { CalendarConfig } from '../../shared/types'
import { errMsg } from '../error'

const KEY_ENABLED = 'agent.calendar_enabled'
const KEY_PATHS = 'agent.calendar_ics_paths'
const MAX_PATHS = 10

export function getCalendarConfig(): CalendarConfig {
  let paths: string[] = []
  try {
    const raw = appConfigRepo.get(KEY_PATHS)
    if (raw) paths = JSON.parse(raw) as string[]
  } catch {
    paths = []
  }
  if (!Array.isArray(paths)) paths = []
  return { enabled: appConfigRepo.get(KEY_ENABLED) === '1', paths }
}

/** 保存配置（白名单校验：.ics 后缀 + 去重 + 上限） */
export function setCalendarConfig(input: Partial<{ enabled: boolean; paths: string[] }>): CalendarConfig {
  if (typeof input.enabled === 'boolean') {
    appConfigRepo.set(KEY_ENABLED, input.enabled ? '1' : '0')
  }
  if (Array.isArray(input.paths)) {
    const seen = new Set<string>()
    const cleaned: string[] = []
    for (const p of input.paths) {
      if (typeof p !== 'string') continue
      const trimmed = p.trim()
      if (!trimmed || !/\.ics$/i.test(trimmed)) continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      cleaned.push(trimmed)
      if (cleaned.length >= MAX_PATHS) break
    }
    appConfigRepo.set(KEY_PATHS, JSON.stringify(cleaned))
  }
  return getCalendarConfig()
}

// ---------- .ics 解析 ----------

export interface IcsEvent {
  start: Date
  end: Date | null
  allDay: boolean
  summary: string
  location: string | null
  description: string | null
}

/** iCalendar 文本反转义（\n \, \; \\） */
export function unescapeText(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/** 解析 DTSTART/DTEND 值；返回 { date, allDay }；无法解析返回 null */
export function parseIcsDate(propValue: string, rawParams: string): { date: Date; allDay: boolean } | null {
  const value = propValue.trim()
  if (/^\d{8}$/.test(value)) {
    // VALUE=DATE 全天事件：本地零点
    const y = Number(value.slice(0, 4))
    const m = Number(value.slice(4, 6))
    const d = Number(value.slice(6, 8))
    if (m < 1 || m > 12 || d < 1 || d > 31) return null
    return { date: new Date(y, m - 1, d), allDay: true }
  }
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!m) return null
  const [, ys, ms, ds, hs, mins, ss, z] = m
  const y = Number(ys)
  const mo = Number(ms) - 1
  const d = Number(ds)
  const h = Number(hs)
  const mi = Number(mins)
  const s = Number(ss)
  if (z === 'Z') return { date: new Date(Date.UTC(y, mo, d, h, mi, s)), allDay: false }
  // TZID 参数存在与否都按本地字面时间处理（见文件头时区策略）
  void rawParams
  return { date: new Date(y, mo, d, h, mi, s), allDay: false }
}

export function parseIcs(content: string): IcsEvent[] {
  // unfold：以空格/Tab 开头的续行拼回上一行（按行拆分需兼容 \r\n 与 \n）
  const rawLines = content.split(/\r\n|\n|\r/)
  const lines: string[] = []
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1)
    } else {
      lines.push(line)
    }
  }

  const events: IcsEvent[] = []
  let cur: Record<string, string> | null = null
  for (const line of lines) {
    const upper = line.toUpperCase()
    if (upper.startsWith('BEGIN:VEVENT')) {
      cur = {}
      continue
    }
    if (upper.startsWith('END:VEVENT')) {
      if (cur) {
        const startInfo = cur.DTSTART ? parseIcsDate(cur.DTSTART, cur.__DTSTART_PARAMS ?? '') : null
        if (startInfo && cur.STATUS?.toUpperCase() !== 'CANCELLED') {
          const endInfo = cur.DTEND ? parseIcsDate(cur.DTEND, cur.__DTEND_PARAMS ?? '') : null
          events.push({
            start: startInfo.date,
            end: endInfo?.date ?? null,
            allDay: startInfo.allDay,
            summary: unescapeText(cur.SUMMARY ?? '(无标题)'),
            location: cur.LOCATION ? unescapeText(cur.LOCATION) : null,
            description: cur.DESCRIPTION ? unescapeText(cur.DESCRIPTION) : null
          })
        }
      }
      cur = null
      continue
    }
    if (!cur) continue
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const propPart = line.slice(0, colon)
    const value = line.slice(colon + 1)
    const semi = propPart.indexOf(';')
    const propName = (semi >= 0 ? propPart.slice(0, semi) : propPart).toUpperCase()
    const params = semi >= 0 ? propPart.slice(semi + 1) : ''
    if (propName === 'DTSTART') {
      cur.DTSTART = value
      cur.__DTSTART_PARAMS = params
    } else if (propName === 'DTEND') {
      cur.DTEND = value
      cur.__DTEND_PARAMS = params
    } else if (propName === 'SUMMARY' || propName === 'LOCATION' || propName === 'DESCRIPTION' || propName === 'STATUS') {
      cur[propName] = value
    }
  }
  return events
}

// ---------- 工具 ----------

export function fmtLocal(d: Date): { date: string; time: string | null } {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: d.getHours() === 0 && d.getMinutes() === 0 ? null : `${pad(d.getHours())}:${pad(d.getMinutes())}`
  }
}

/** range → [起, 止)（upcoming 为 now 起未来 30 天） */
export function rangeWindow(range: string): { label: string; from: Date; to: Date | null } {
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const DAY = 24 * 60 * 60 * 1000
  switch (range) {
    case 'today':
      return { label: '今天', from: dayStart, to: new Date(dayStart.getTime() + DAY) }
    case 'tomorrow':
      return { label: '明天', from: new Date(dayStart.getTime() + DAY), to: new Date(dayStart.getTime() + 2 * DAY) }
    case 'this-week': {
      const dow = (now.getDay() + 6) % 7 // 周一=0
      const monday = new Date(dayStart.getTime() - dow * DAY)
      return { label: '本周', from: monday, to: new Date(monday.getTime() + 7 * DAY) }
    }
    case 'upcoming':
      return { label: '未来30天', from: now, to: new Date(now.getTime() + 30 * DAY) }
    default:
      return { label: '全部', from: new Date(0), to: null }
  }
}

export const calendarReadTool: BuiltinTool = {
  schema: {
    id: 'calendar.read',
    name: 'calendar_read',
    description:
      '读取用户配置的本地日历日程（.ics 文件，需在 Agent 页启用并添加日历文件）。参数：range (string，可选：today/tomorrow/this-week/upcoming/all，默认 today)。',
    parameters: {
      type: 'object',
      properties: {
        range: { type: 'string', description: 'today / tomorrow / this-week / upcoming / all' }
      },
      required: [],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'confirm'
  },
  async execute(args) {
    const cfg = getCalendarConfig()
    if (!cfg.enabled) throw new Error('日历工具未启用：请到 Agent 页勾选「日历」并添加 .ics 日历文件')
    if (cfg.paths.length === 0) throw new Error('未添加日历文件：请到 Agent 页点击「添加 .ics」选择日历导出文件')

    const range = String(args?.range ?? 'today').trim() || 'today'
    const win = rangeWindow(range)

    const all: (IcsEvent & { source: string })[] = []
    const errors: string[] = []
    for (const p of cfg.paths) {
      try {
        const content = fs.readFileSync(p, 'utf8')
        for (const ev of parseIcs(content)) all.push({ ...ev, source: p })
      } catch (e) {
        errors.push(`${p}: ${errMsg(e)}`)
      }
    }

    const hit = all
      .filter((ev) => ev.start >= win.from && (win.to === null || ev.start < win.to))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, 50)
      .map((ev) => ({
        ...fmtLocal(ev.start),
        end: ev.end ? fmtLocal(ev.end).date : null,
        allDay: ev.allDay,
        summary: ev.summary,
        location: ev.location,
        description: ev.description && ev.description.length > 200 ? ev.description.slice(0, 200) + '…' : ev.description
      }))

    return JSON.stringify({
      range: win.label,
      count: hit.length,
      events: hit,
      ...(errors.length > 0 ? { readErrors: errors } : {})
    })
  }
}
