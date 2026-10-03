// 定时提醒 IPC/工具入参 schema（repo 层复用作二道防线）
import { z } from 'zod'

export const reminderTextSchema = z
  .string()
  .trim()
  .min(1, '提醒内容不能为空')
  .max(500, '提醒内容过长（最多 500 字符）')

export const reminderIdSchema = z.string().min(1)

export const REMINDER_STATUSES = ['pending', 'fired', 'cancelled', 'missed'] as const

export const reminderStatusSchema = z.enum(REMINDER_STATUSES)

/** 待触发提醒条数上限（工具 / 用户直建 IPC 共用，集中一处） */
export const MAX_PENDING_REMINDERS = 50
/** 最长提前量：30 天（分钟） */
export const MAX_REMINDER_MINUTES = 43_200

/** REMINDER_CREATE（消息右键直建）入参 schema；时间范围在主进程二次校验 */
export const reminderCreateSchema = z.object({
  text: reminderTextSchema,
  fireAt: z.number().int().positive('触发时间非法'),
  conversationId: reminderIdSchema.nullish()
})
