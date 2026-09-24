// 用户记忆 IPC 入参 schema（repo/service 层复用作二道防线）
import { z } from 'zod'

export const memoryContentSchema = z
  .string()
  .trim()
  .min(1, '记忆内容不能为空')
  .max(2000, '记忆内容过长（最多 2000 字符）')

export const memoryIdSchema = z.string().min(1)
