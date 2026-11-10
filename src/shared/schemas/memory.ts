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

/**
 * §379：注入侧的三档上限此前只活在主进程 `assistant/memory.ts` 里，设置页把每条记忆完整显示、
 * 那句提示只说「记忆将注入对话上下文」⇒ 屏上 60 条全在、模型实际只收到最近 50 条且受总字数预算，
 * 一条 1500 字的记忆模型只看到前 200 字，三档截断一处都没说过。数字搬到这里与 MEMORY_MAX_CONTENT_CHARS
 * 同一处，让主进程的预算与渲染层的披露读同一份（同 §333 给 maxLength 做的同源）。
 */
export const MEMORY_INJECT_MAX_ITEMS = 50
export const MEMORY_INJECT_MAX_ITEM_CHARS = 200
export const MEMORY_INJECT_MAX_TOTAL_CHARS = 2000

/**
 * 活跃记忆行数上限。取值依据：注入侧只看最新 50 条、总 2000 字，留 20 倍于可见窗口的裁量空间；
 * 每行内容上限 2000 字符，1000 行最坏约 200 万字符（UTF-8 中文约 6 MB），对本地 SQLite 无压力，
 * 也能让设置页一次列出。到上限后**拒绝新的写入/恢复**，不自动清理最旧——静默删用户数据不可接受；
 * 既有超出上限的数据保持原样，只挡住新增。
 */
export const MEMORY_MAX_ROWS = 1000

/** 批量物理清理的入参：空数组直接拒绝；单次 10000 条，避免异常数据把一次 IPC 撑爆 */
export const memoryIdsSchema = z.array(memoryIdSchema).min(1).max(10000)
