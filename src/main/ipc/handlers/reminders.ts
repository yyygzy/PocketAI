// 提醒 IPC：消息右键「提醒我」用户直建（Agent 工具走 reminder_set，不经此）。
// scheduler 30s tick 自动拾取 pending，无需在此触发任何调度。
import { IPC } from '../../../shared/types'
import type { ReminderRecord } from '../../../shared/types'
import { safeHandle, argsSchema, z } from '../safe-handle'
import {
  reminderCreateSchema,
  MAX_PENDING_REMINDERS,
  MAX_REMINDER_MINUTES
} from '../../../shared/schemas/reminder'
import { reminderRepo } from '../../db/repositories/reminder.repo'

export function registerReminderHandlers(): void {
  safeHandle(IPC.REMINDER_CREATE, async (_e, arg: z.infer<typeof reminderCreateSchema>) => {
    const now = Date.now()
    // 主进程二次校验：1 分钟步进可能算出 now（极端情况），且渲染端时间不可信
    if (!Number.isFinite(arg.fireAt) || arg.fireAt <= now) throw new Error('触发时间必须晚于当前时间')
    if (arg.fireAt > now + MAX_REMINDER_MINUTES * 60_000) throw new Error('提醒最远只能设置 30 天后')
    if (reminderRepo.countPending() >= MAX_PENDING_REMINDERS)
      throw new Error(`待触发提醒已达上限 ${MAX_PENDING_REMINDERS} 条`)

    const rec: ReminderRecord = reminderRepo.create(arg.text.trim(), arg.fireAt, arg.conversationId ?? null)
    return { ok: true as const, id: rec.id, fireAt: rec.fireAt }
  }, argsSchema(reminderCreateSchema))
}
