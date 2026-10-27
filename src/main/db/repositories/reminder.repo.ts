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


/** 候选仍 ≤ now 时按周期追平（§332）。
 *  用闭式而不是循环：要追平的幅度只受"这台应用多久没醒"限制（三个月不关机也追得平），
 *  循环就得挑一个"够大"的次数上限，而上限本身就是下一个坑。 */
function advancePastNow(candidate: number, periodMs: number, now: number): number {
  if (candidate > now) return candidate
  // d = now - candidate ≥ 0，取 floor(d/p)+1 保证 candidate + k·p 严格大于 now
  const k = Math.floor((now - candidate) / periodMs) + 1
  return candidate + k * periodMs
}

/** 计算下一次循环触发时间（epoch ms）：
 * - daily: prevFireAt + intervalDays 天
 * - weekly: 找 prevFireAt 之后的下一个匹配 weekday
 * - monthly: 下一自然月的 dayOfMonth（不存在则取该月最后一天）
 * 三档都必须保证结果 **> now**（§332：改前这句只写在注释里，daily／weekly 都没兑现——
 * 错过几天时交出去的还是过去时刻，`scheduler.ts:29` 把它原样写回 pending，
 * 下一个 30s tick 又算"到期"，于是一条周五的日提醒在周一连环弹出多次通知才追平） */
export function computeNextFireAt(prevFireAt: number, rule: ReminderRepeatRule, now: number): number {
  if (rule.kind === 'daily') {
    const period = rule.intervalDays * 86_400_000
    return advancePastNow(prevFireAt + period, period, now)
  }
  if (rule.kind === 'weekly') {
    const days = rule.weekdays
    if (days.length === 0) return advancePastNow(prevFireAt + 7 * 86_400_000, 7 * 86_400_000, now)
    const base = new Date(prevFireAt)
    for (let i = 1; i <= 7; i++) {
      const d = new Date(base.getTime() + i * 86_400_000)
      const dow = ((d.getDay() + 6) % 7) + 1 // 周一=1 ... 周日=7
      if (days.includes(dow)) return advancePastNow(d.getTime(), 7 * 86_400_000, now)
    }
    return advancePastNow(prevFireAt + 7 * 86_400_000, 7 * 86_400_000, now)
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
   *  一次性 missed（无 repeatRule）不支持，返回 ok=false 由前端引导用户新建 */
  rescheduleNext(id: string): { ok: boolean; fireAt?: number } {
    const rec = this.get(reminderIdSchema.parse(id))
    if (!rec || !rec.repeatRule) return { ok: false }
    const next = computeNextFireAt(rec.fireAt, rec.repeatRule, Date.now())
    const ok = this.reschedule(rec.id, next, rec.repeatRule)
    return ok ? { ok: true, fireAt: next } : { ok: false }
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
