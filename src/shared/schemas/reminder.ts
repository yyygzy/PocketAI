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
