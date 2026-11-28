// calendar.read 工具：读取本地 .ics（iCalendar）日程文件
//
// - 零依赖轻量解析：RFC5545 unfold（续行）→ VEVENT 块 → DTSTART/DTEND/SUMMARY 等
// - 时区策略：带 Z 后缀按 UTC 转本地；TZID 忽略时区名、按字面时间作本地时间
//  （国内场景日历多为本地时区导出，够用；跨时区日程以 Z 格式为准）
// - RRULE 重复事件 v1 不展开（只返回原定时刻），STATUS:CANCELLED 跳过
// - 配置存 app_config：agent.calendar_enabled / agent.calendar_ics_paths（JSON 数组）
// - SEC-16-09：写入通道只收 AGENT_PICK_ICS_FILE 签发的 path token（resolveIcsPathTokens
//   先把 token 解析回真实路径），渲染端无法再指定任意绝对路径让主进程读
import fs from 'node:fs'
import type { BuiltinTool } from './builtin'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { resolveSharedPathList, serializeSharedPath, resolveSharedPath } from '../portable-paths'
import type { ApprovalPreviewField, CalendarConfig } from '../../shared/types'
import { errMsg } from '../error'
import { peekPathToken } from '../ipc/dialog-path-token'

const KEY_ENABLED = 'agent.calendar_enabled'
const KEY_PATHS = 'agent.calendar_ics_paths'
const MAX_PATHS = 10
/** SEC-28：单个 .ics 的字节闸（路径数有 MAX_PATHS，单文件此前无界，恶意/异常导出可打爆内存） */
const MAX_ICS_BYTES = 8 * 1024 * 1024
/** SEC-28：unfold 后单行字符闸（续行可无限拼回上一行，单行本身也是全量物化） */
const MAX_ICS_LINE_CHARS = 64 * 1024

export function getCalendarConfig(): CalendarConfig {
  let paths: string[] = []
  try {
    const raw = appConfigRepo.get(KEY_PATHS)
    if (raw) paths = resolveSharedPathList(JSON.parse(raw) as string[])
  } catch {
    paths = []
  }
  if (!Array.isArray(paths)) paths = []
  return { enabled: appConfigRepo.get(KEY_ENABLED) === '1', paths }
}

/** 读库里的原始（序列化形式）路径清单；坏 JSON 当空清单 */
function readStoredPaths(): string[] {
  try {
    const raw = appConfigRepo.get(KEY_PATHS)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    return []
  }
}

/**
 * SEC-16-09：把渲染端传来的 path token 解析回真实路径。
 * 任何不是本进程签发的句柄（含裸绝对路径、过期/未知 token）都解析不出来——
 * 这就是写入通道的闸门：渲染端只能引用「对话框刚选中过」的文件。
 * peek 不消费，保存失败可整批重试；保存成功后由调用方 dropPathToken 一次性作废。
 */
export function resolveIcsPathTokens(tokens: unknown): { paths: string[]; unknownCount: number } {
  const paths: string[] = []
  let unknownCount = 0
  for (const t of Array.isArray(tokens) ? tokens : []) {
    const p = peekPathToken(typeof t === 'string' ? t : undefined)
    if (p) paths.push(p)
    else unknownCount++
  }
  return { paths, unknownCount }
}

/**
 * 清洗待追加的候选路径（复用既有规则：.ics 后缀 + 序列化 + 去重 + 上限）。
 * existing 传当前已存清单（序列化形式）：新增去重要连旧值一起比对，否则同一文件
 * 逐次「添加」会以不同的存储形式混进清单。
 */
export function cleanIcsCandidates(candidates: unknown[], existing: string[]): string[] {
  const seen = new Set(existing.map((p) => p.toLowerCase()))
  const cleaned: string[] = []
  for (const p of candidates) {
    if (typeof p !== 'string') continue
    const trimmed = p.trim()
    if (!trimmed) continue
    const stored = serializeSharedPath(trimmed) ?? trimmed
    if (!/\.ics$/i.test(stored)) continue
    const key = stored.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    cleaned.push(stored)
    if (cleaned.length >= MAX_PATHS) break
  }
  return cleaned
}

/**
 * 保存配置（SEC-16-09 后的写入面：addPaths/removePaths 均为**主进程解析出的绝对路径**，
 * 不再整表替换——渲染端只持有 token，无法把已存路径原样传回，所以追加/移除各自成patch）。
 */
export function setCalendarConfig(patch: {
  enabled?: boolean
  addPaths?: string[]
  removePaths?: string[]
}): CalendarConfig {
  if (typeof patch.enabled === 'boolean') {
    appConfigRepo.set(KEY_ENABLED, patch.enabled ? '1' : '0')
  }
  const stored = readStoredPaths()
  if (Array.isArray(patch.addPaths) && patch.addPaths.length > 0) {
    const added = cleanIcsCandidates(patch.addPaths, stored)
    if (added.length > 0) appConfigRepo.set(KEY_PATHS, JSON.stringify([...stored, ...added]))
  }
  if (Array.isArray(patch.removePaths) && patch.removePaths.length > 0) {
    // 移除按解析后的绝对路径比对（Windows 不分大小写）：渲染端拿到的就是回读的绝对路径
    const doomed = new Set(
      patch.removePaths
        .filter((p): p is string => typeof p === 'string')
        .map((p) => (resolveSharedPath(p) ?? p).toLowerCase())
    )
    const kept = stored.filter((s) => !doomed.has((resolveSharedPath(s) ?? s).toLowerCase()))
    if (kept.length !== stored.length) appConfigRepo.set(KEY_PATHS, JSON.stringify(kept))
  }
  return getCalendarConfig()
}

/**
 * SEC-16-09 审批披露：calendar_read 审批弹窗补上「实际会读哪些文件」。
 * 参数里只有 range，读取面在主进程配置里，通用启发式（buildToolPreviewFields）看不到；
 * 引擎 buildApprovalDisplay 沿用 fs_write/project_create 的专用 builder 模式在这里接线。
 */
export function buildCalendarApprovalPreview(cfg: CalendarConfig = getCalendarConfig()): {
  fields: ApprovalPreviewField[]
} {
  // 只展示文件名（读全路径对用户判断「会读什么」没有增益，还把目录结构摊给旁观者）
  const names = cfg.paths.map((p) => p.split(/[\\/]/).filter(Boolean).pop() || p)
  const shown = names.slice(0, 8).join('、')
  const value =
    names.length === 0
      ? '（清单为空，本次不会读取任何文件）'
      : `${names.length} 个：${shown}${names.length > 8 ? ' 等' : ''}`
  return { fields: [{ key: 'calendar_files', value }] }
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

/** 读取单个 .ics：先过字节闸再整读（超限直接抛，由调用方计入 readErrors） */
export function readIcsContent(p: string): string {
  if (fs.statSync(p).size > MAX_ICS_BYTES) {
    throw new Error(`ICS 超过 ${Math.floor(MAX_ICS_BYTES / (1024 * 1024))}MB 上限，已跳过`)
  }
  return fs.readFileSync(p, 'utf8')
}

export function parseIcs(content: string): IcsEvent[] {
  // unfold：以空格/Tab 开头的续行拼回上一行（按行拆分需兼容 \r\n 与 \n）
  const rawLines = content.split(/\r\n|\n|\r/)
  const lines: string[] = []
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      // 续行无限拼接会把「一行」撑到任意长度，超过上限即丢弃后续部分
      lines[lines.length - 1] = (lines[lines.length - 1] + line.slice(1)).slice(0, MAX_ICS_LINE_CHARS)
    } else {
      lines.push(line.slice(0, MAX_ICS_LINE_CHARS))
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
        const content = readIcsContent(p)
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
