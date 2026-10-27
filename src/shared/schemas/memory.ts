// 用户记忆 IPC 入参 schema（repo/service 层复用作二道防线）
import { z } from 'zod'

/** §333：这道上限此前只活在 zod 里，输入框没有 `maxLength` ⇒ 粘一段 2001 字的记忆按「添加」，
 *  整条被拒、而界面先一步把用户敲的那段清空了。数字提成一份，让渲染层的闸与它同源。 */
export const MEMORY_MAX_CONTENT_CHARS = 2000

export const memoryContentSchema = z
  .string()
  .trim()
  .min(1, '记忆内容不能为空')
  .max(MEMORY_MAX_CONTENT_CHARS, '记忆内容过长（最多 2000 字符）')

export const memoryIdSchema = z.string().min(1)
