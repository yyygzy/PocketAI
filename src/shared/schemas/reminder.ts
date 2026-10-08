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

/** REMINDER_LIST 查询范围：pending=待发（默认），history=已触发/已错过/已取消 */
export const reminderListScopeSchema = z.enum(['pending', 'history'])

/** 待触发提醒条数上限（工具 / 用户直建 IPC 共用，集中一处） */
export const MAX_PENDING_REMINDERS = 50
/** 最长提前量：30 天（分钟） */
export const MAX_REMINDER_MINUTES = 43_200

/** daily 循环规则：1-365 天间隔 */
const reminderDailyRuleSchema = z.object({
  kind: z.literal('daily'),
  intervalDays: z.number().int().min(1).max(365)
})

/** weekly 循环规则：周一=1 ... 周日=7；至少 1 个、去重、范围 1-7 */
const reminderWeeklyRuleSchema = z.object({
  kind: z.literal('weekly'),
  weekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7)
})

/** monthly 循环规则：1-31 号；不存在日（如 2 月 30 号）回退到当月最后一天 */
const reminderMonthlyRuleSchema = z.object({
  kind: z.literal('monthly'),
  dayOfMonth: z.number().int().min(1).max(31)
})

/** 循环提醒规则联合（3 种 kind，不做 cron 表达式） */
export const reminderRepeatRuleSchema = z.union([
  reminderDailyRuleSchema,
  reminderWeeklyRuleSchema,
  reminderMonthlyRuleSchema
])

/** REMINDER_CREATE（消息右键直建 / Agent 工具）入参 schema；时间范围在主进程二次校验 */
export const reminderCreateSchema = z.object({
  text: reminderTextSchema,
  fireAt: z.number().int().positive('触发时间非法'),
  conversationId: reminderIdSchema.nullish(),
  repeatRule: reminderRepeatRuleSchema.optional()
})

/** REMINDER_RESCHEDULE（历史 tab「重新安排」）入参 schema */
export const reminderRescheduleSchema = z.object({
  id: reminderIdSchema,
  fireAt: z.number().int().positive('触发时间非法'),
  repeatRule: reminderRepeatRuleSchema.optional()
})

/** REMINDER_UPDATE（pending 行编辑）入参 schema；
 *  repeatRule: undefined=不改（不传该字段），null=清除变一次性，对象=改循环规则 */
export const reminderUpdateSchema = z.object({
  id: reminderIdSchema,
  text: reminderTextSchema.optional(),
  fireAt: z.number().int().positive('触发时间非法').optional(),
  repeatRule: reminderRepeatRuleSchema.nullable()
})
