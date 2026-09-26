// 定时提醒数据访问（Agent reminder_set/list/cancel 内置工具读写 + reminder scheduler 扫描触发）
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import {
  reminderTextSchema,
  reminderIdSchema,
  reminderStatusSchema,
} from '../../../shared/schemas/reminder'
import type { ReminderRecord, ReminderStatus } from '../../../shared/types'

interface ReminderRow {
  id: string
  text: string | null
  fire_at: number
  status: string | null
  conversation_id: string | null
  created_at: number
}

function rowToRecord(row: ReminderRow): ReminderRecord {
  return {
    id: row.id,
    text: row.text ?? '',
    fireAt: row.fire_at,
    status: (row.status as ReminderStatus) ?? 'pending',
    conversationId: row.conversation_id ?? null,
    createdAt: row.created_at,
  }
}

export const reminderRepo = {
  create(
    text: string,
    fireAt: number,
    conversationId?: string | null
  ): ReminderRecord {
    const parsedText = reminderTextSchema.parse(text)
    const now = Date.now()
    const id = randomUUID()
    dbService
      .getHandle()
      .prepare(
        'INSERT INTO reminders (id, text, fire_at, status, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(id, parsedText, fireAt, 'pending', conversationId ?? null, now)
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
