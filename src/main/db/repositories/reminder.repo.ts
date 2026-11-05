// 定时提醒数据访问（Agent reminder_set/list/cancel 内置工具读写 + reminder scheduler 扫描触发）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import {
  reminderTextSchema,
  reminderIdSchema,
  reminderStatusSchema,
} from '../../../shared/schemas/reminder'
import type { ReminderRecord, ReminderRepeatRule, ReminderStatus } from '../../../shared/types'

interface ReminderRow {
  id: string
  text: string | null
  fire_at: number
  status: string | null
  conversation_id: string | null
  created_at: number
  repeat_rule: string | null
}

/** 解析 repeat_rule JSON 容错：坏 JSON/非对象 → undefined；仅放行合法 daily/weekly/monthly */
function parseRepeatRule(raw: string | null): ReminderRepeatRule | undefined {
  if (!raw) return undefined
  try {
    const v = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return undefined
    const r = v as Record<string, unknown>
    if (r.kind === 'daily' && typeof r.intervalDays === 'number') {
      return { kind: 'daily', intervalDays: r.intervalDays }
    }
    if (r.kind === 'weekly' && Array.isArray(r.weekdays)) {
      return { kind: 'weekly', weekdays: r.weekdays.filter((d) => typeof d === 'number') as number[] }
    }
    if (r.kind === 'monthly' && typeof r.dayOfMonth === 'number') {
      return { kind: 'monthly', dayOfMonth: r.dayOfMonth }
    }
    return undefined
  } catch {
    return undefined
  }
}

function rowToRecord(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    text: row.text ?? '',
    fireAt: row.fire_at,
    status: (row.status as ReminderStatus) ?? 'pending',
    conversationId: row.conversation_id ?? null,
    createdAt: row.created_at,
    repeatRule: parseRepeatRule(row.repeat_rule),
  }
}

/** 给定「年月可溢出」的月序号，取该月 dayOfMonth 号（超出月长则回落到月末）的时刻，时分秒沿用 base */
function monthDayAt(year: number, monthIndex: number, dayOfMonth: number, base: Date): number {
  const first = new Date(year, monthIndex, 1)
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(
    first.getFullYear(),
    first.getMonth(),
    Math.min(dayOfMonth, lastDay),
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds()
  ).getTime()
}


/** 以**本地日历**推进 n 天：直接改 Date 的日字段，时分秒沿用原值。
 *  跨夏令时时一个本地日不是固定 86_400_000ms（23h/25h），所以不能用毫秒加法。 */
function addLocalDays(ts: number, days: number): number {
  const d = new Date(ts)
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + days,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds()
  ).getTime()
}

/** 候选仍 ≤ now 时按本地日历周期追平（§332 的"结果必须 > now"口径不变）。
 *  先按 24h 粗估步数（DST 造成的日长变化是常数级 ±1h，估算最多差一步），
 *  再用日历步进收尾：结果严格 > now，且本地钟点与候选一致。 */
function advanceDaysPastNow(candidate: number, intervalDays: number, now: number): number {
  if (candidate > now) return candidate
  const approxSteps = Math.floor((now - candidate) / (intervalDays * 86_400_000))
  let cur = approxSteps > 0 ? addLocalDays(candidate, approxSteps * intervalDays) : candidate
  while (cur <= now) cur = addLocalDays(cur, intervalDays)
  return cur
}

/** 计算下一次循环触发时间（epoch ms）：
 * - daily: prevFireAt 之后 intervalDays 个**本地日历日**
 * - weekly: 找 prevFireAt 之后的下一个匹配 weekday（同样按本地日历日步进）
 * - monthly: 下一自然月的 dayOfMonth（不存在则取该月最后一天）
 * daily/weekly 不再用固定 86_400_000ms 加法：四语 UI 覆盖有夏令时的地区时，
 * 固定毫秒会让触发钟点漂一小时；按日历日推进则本地钟点不变。
 * 三档都必须保证结果 **> now**（§332：改前这句只写在注释里，daily／weekly 都没兑现——
 * 错过几天时交出去的还是过去时刻，`scheduler.ts:29` 把它原样写回 pending，
 * 下一个 30s tick 又算"到期"，于是一条周五的日提醒在周一连环弹出多次通知才追平） */
export function computeNextFireAt(prevFireAt: number, rule: ReminderRepeatRule, now: number): number {
  if (rule.kind === 'daily') {
    // 按本地日历日推进：跨夏令时也落在同样的本地钟点（不是固定 24h）
    return advanceDaysPastNow(addLocalDays(prevFireAt, rule.intervalDays), rule.intervalDays, now)
  }
  if (rule.kind === 'weekly') {
    const days = rule.weekdays
    if (days.length === 0) return advanceDaysPastNow(addLocalDays(prevFireAt, 7), 7, now)
    for (let i = 1; i <= 7; i++) {
      const candidate = addLocalDays(prevFireAt, i)
      const dow = ((new Date(candidate).getDay() + 6) % 7) + 1 // 周一=1 ... 周日=7
      if (days.includes(dow)) return advanceDaysPastNow(candidate, 7, now)
    }
    return advanceDaysPastNow(addLocalDays(prevFireAt, 7), 7, now)
  }
  // monthly：下一个自然月的 dayOfMonth；该月没有这天就取当月最后一天（2 月 30 号→2 月末）
  const base = new Date(prevFireAt)
  // §332：改前的 `guard < 8` 是正确性边界而不是兜底——错过 8 个月以上（长期关机／补录旧规则）
  // 交出去的还是**过去时刻**，scheduler 把它原样写回 pending，下一个 tick 又算"到期"。
  // 递推不设上限：步数＝错过的月数，候选每月严格前进，任何有限的 now 都会停。
  // （曾试过"起点直接跳到 now 所在月"：那条变异 W31 存活＝那一跳没有任何可判差异，
  //  正确性全在这句递推里 ⇒ 按「零效果的守卫直接删」撤掉，只留用例钉得住的那一种写法。）
  let monthCursor = base.getMonth() + 1
  let result = monthDayAt(base.getFullYear(), monthCursor, rule.dayOfMonth, base)
  while (result <= now) {
    monthCursor += 1
    result = monthDayAt(base.getFullYear(), monthCursor, rule.dayOfMonth, base)
  }
  return result
}

export const reminderRepo = {
  create(
    text: string,
    fireAt: number,
    conversationId?: string | null,
    repeatRule?: ReminderRepeatRule
  ): ReminderRecord {
    const parsedText = reminderTextSchema.parse(text)
    const now = Date.now()
    const id = randomUUID()
    const ruleJson = repeatRule ? JSON.stringify(repeatRule) : null
    dbService
      .getHandle()
      .prepare(
        'INSERT INTO reminders (id, text, fire_at, status, conversation_id, created_at, repeat_rule) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(id, parsedText, fireAt, 'pending', conversationId ?? null, now, ruleJson)
    return this.get(id)!
  },

  get(id: string): ReminderRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE id=?')
      .get(reminderIdSchema.parse(id)) as ReminderRow | undefined
    return row ? rowToRecord(row) : null
  },

  listPending(limit = 50): ReminderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE status=? ORDER BY fire_at ASC LIMIT ?')
      .all('pending', limit) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  listByStatus(status: ReminderStatus, limit = 50): ReminderRecord[] {
    reminderStatusSchema.parse(status)
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE status=? ORDER BY fire_at DESC LIMIT ?')
      .all(status, limit) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  /** 历史（已触发/已错过/已取消）：到期时间倒序，上限 50（提醒中心历史 tab） */
  listHistory(limit = 50): ReminderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare(
        "SELECT * FROM reminders WHERE status IN ('fired','missed','cancelled') ORDER BY fire_at DESC LIMIT ?"
      )
      .all(limit) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  listDue(now: number): ReminderRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE status=? AND fire_at<=? ORDER BY fire_at ASC')
      .all('pending', now) as ReminderRow[]
    return rows.map(rowToRecord)
  },

  markFired(id: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=? WHERE id=?')
      .run('fired', reminderIdSchema.parse(id))
  },

  markMissed(id: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=? WHERE id=?')
      .run('missed', reminderIdSchema.parse(id))
  },

  /** 循环提醒到点重排：UPDATE fire_at 与 repeat_rule，状态保持 pending（不新建记录） */
  scheduleNext(id: string, fireAt: number, rule: ReminderRepeatRule): void {
    dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=?, fire_at=?, repeat_rule=? WHERE id=?')
      .run('pending', fireAt, JSON.stringify(rule), reminderIdSchema.parse(id))
  },

  /** 历史 tab「重新安排」：missed/cancelled/fired 行重置 pending，可选改循环规则 */
  reschedule(id: string, fireAt: number, rule?: ReminderRepeatRule): boolean {
    const info = dbService
      .getHandle()
      .prepare('UPDATE reminders SET status=?, fire_at=?, repeat_rule=? WHERE id=?')
      .run(
        'pending',
        fireAt,
        rule ? JSON.stringify(rule) : null,
        reminderIdSchema.parse(id)
      )
    return info.changes > 0
  },

  /** 编辑 pending 行：动态拼 UPDATE，仅 pending 状态可改（防终态行被改）；
   *  repeatRule: undefined=不改字段，null=清除变一次性，对象=改循环规则 */
  update(
    id: string,
    fields: { text?: string; fireAt?: number; repeatRule?: ReminderRepeatRule | null }
  ): boolean {
    const sets: string[] = []
    const params: (string | number | null)[] = []
    if (fields.text !== undefined) {
      sets.push('text=?')
      params.push(reminderTextSchema.parse(fields.text))
    }
    if (fields.fireAt !== undefined) {
      sets.push('fire_at=?')
      params.push(fields.fireAt)
    }
    if (fields.repeatRule !== undefined) {
      sets.push('repeat_rule=?')
      params.push(fields.repeatRule ? JSON.stringify(fields.repeatRule) : null)
    }
    if (sets.length === 0) return false
    params.push(reminderIdSchema.parse(id))
    const info = dbService
      .getHandle()
      .prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id=? AND status='pending'`)
      .run(...params)
    return info.changes > 0
  },

  /** 一键重新安排 missed 循环提醒：按原 rule 用 computeNextFireAt 重算下次触发回 pending。
   *  一次性 missed（无 repeatRule）不支持，返回 ok=false 由前端引导用户新建。
   *  **读-改-写收窄到一次条件 UPDATE**：期望值（status/fire_at/repeat_rule）取自刚才读到的快照，
   *  期间被 30s tick 或另一次点击改过 ⇒ changes=0，本次不生效（不会覆盖别人写下的 fire_at）。
   *  pending 行不在可重排范围：条件里有 `status<>'pending'`，循环提醒不会被推掉当前周期。 */
  rescheduleNext(id: string): { ok: boolean; fireAt?: number } {
    const rid = reminderIdSchema.parse(id)
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM reminders WHERE id=?')
      .get(rid) as ReminderRow | undefined
    if (!row) return { ok: false }
    const rec = rowToRecord(row)
    if (!rec.repeatRule || rec.status === 'pending') return { ok: false }
    const next = computeNextFireAt(rec.fireAt, rec.repeatRule, Date.now())
    const info = dbService
      .getHandle()
      .prepare(
        `UPDATE reminders SET status=?, fire_at=?, repeat_rule=?
         WHERE id=? AND status=? AND fire_at=? AND repeat_rule IS ?`
      )
      .run('pending', next, JSON.stringify(rec.repeatRule), rid, rec.status, rec.fireAt, row.repeat_rule ?? null)
    return info.changes > 0 ? { ok: true, fireAt: next } : { ok: false }
  },

  cancel(id: string): boolean {
    const info = dbService
      .getHandle()
      .prepare("UPDATE reminders SET status='cancelled' WHERE id=? AND status='pending'")
      .run(reminderIdSchema.parse(id))
    return info.changes > 0
  },

  countPending(): number {
    const row = dbService
      .getHandle()
      .prepare("SELECT COUNT(*) AS n FROM reminders WHERE status='pending'")
      .get() as { n: number } | undefined
    return row?.n ?? 0
  },
}
