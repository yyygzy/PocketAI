// 提醒 IPC：消息右键「提醒我」用户直建（Agent 工具走 reminder_set，不经此）。
// scheduler 30s tick 自动拾取 pending，无需在此触发任何调度。
import { IPC } from '../../../shared/types'
import type { ReminderRecord } from '../../../shared/types'
import { safeHandle, argsSchema, z } from '../safe-handle'
import {
  reminderCreateSchema,
  reminderRescheduleSchema,
  reminderUpdateSchema,
  reminderIdSchema,
  reminderListScopeSchema,
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

    const rec: ReminderRecord = reminderRepo.create(
      arg.text.trim(),
      arg.fireAt,
      arg.conversationId ?? null,
      arg.repeatRule
    )
    return { ok: true as const, id: rec.id, fireAt: rec.fireAt }
  }, argsSchema(reminderCreateSchema))

  // 提醒列表：无参/ pending=待发（升序 50 条）；history=已触发/已错过/已取消（倒序 50 条）
  safeHandle(
    IPC.REMINDER_LIST,
    async (_e, scope?: 'pending' | 'history') =>
      scope === 'history' ? reminderRepo.listHistory() : reminderRepo.listPending(),
    argsSchema(reminderListScopeSchema.optional())
  )

  // 取消提醒：仅 pending 可撤，已触发/已取消返回 ok=false（弹窗侧据此重拉）
  safeHandle(IPC.REMINDER_CANCEL, async (_e, id: string) => {
    return { ok: reminderRepo.cancel(reminderIdSchema.parse(id)) }
  }, argsSchema(reminderIdSchema))

  // 重新安排历史提醒：missed/cancelled/fired 行回 pending，可选改循环规则
  safeHandle(
    IPC.REMINDER_RESCHEDULE,
    async (_e, arg: z.infer<typeof reminderRescheduleSchema>) => {
      const now = Date.now()
      if (!Number.isFinite(arg.fireAt) || arg.fireAt <= now) throw new Error('触发时间必须晚于当前时间')
      if (arg.fireAt > now + MAX_REMINDER_MINUTES * 60_000) throw new Error('提醒最远只能设置 30 天后')
      // reschedule 不增总数（同一条记录 UPDATE pending），但若该条原为 pending 仍算 pending 不冲突
      const ok = reminderRepo.reschedule(arg.id, arg.fireAt, arg.repeatRule)
      return { ok }
    },
    argsSchema(reminderRescheduleSchema)
  )

  // 编辑 pending 提醒：改时间/文本/循环规则（仅 pending 行可改，fireAt > now 且 ≤ now+30d）
  safeHandle(
    IPC.REMINDER_UPDATE,
    async (_e, arg: z.infer<typeof reminderUpdateSchema>) => {
      const now = Date.now()
      if (arg.fireAt !== undefined) {
        if (!Number.isFinite(arg.fireAt) || arg.fireAt <= now) throw new Error('触发时间必须晚于当前时间')
        if (arg.fireAt > now + MAX_REMINDER_MINUTES * 60_000) throw new Error('提醒最远只能设置 30 天后')
      }
      const ok = reminderRepo.update(arg.id, {
        text: arg.text,
        fireAt: arg.fireAt,
        repeatRule: arg.repeatRule
      })
      return { ok }
    },
    argsSchema(reminderUpdateSchema)
  )

  // 一键重新安排 missed 循环提醒：按原 rule 重算下次触发回 pending
  safeHandle(IPC.REMINDER_RESCHEDULE_NEXT, async (_e, id: string) => {
    return reminderRepo.rescheduleNext(reminderIdSchema.parse(id))
  }, argsSchema(reminderIdSchema))
}
