// 用户记忆上下文构建：注入 SystemPrompt，让 LLM 感知用户偏好与事实
// 上限控制：条目数 + 单条长度 + 总字符，防止撑爆 token 窗口
// §379：三档数字住在 shared（与设置页那句披露同源），这里不再各写一份
import { userMemoryRepo } from '../db/repositories/user-memory.repo'
import {
  MEMORY_INJECT_MAX_ITEMS,
  MEMORY_INJECT_MAX_ITEM_CHARS,
  MEMORY_INJECT_MAX_TOTAL_CHARS
} from '../../shared/schemas/memory'

export function buildMemoryContext(): string {
  const memories = userMemoryRepo.list()
  const items = memories
    .slice(0, MEMORY_INJECT_MAX_ITEMS)
    .map((m) => m.content.replace(/\s+/g, ' ').trim().slice(0, MEMORY_INJECT_MAX_ITEM_CHARS))
    .filter(Boolean)
  if (items.length === 0) return ''

  const lines: string[] = []
  let total = 0
  for (const item of items) {
    const line = `- ${item}`
    // §379：改前是 `break`＝一条长记忆把后面**塞得下的**短记忆整批挤掉（现量：10 条 200 字 + 8 条 20 字
    // ⇒ break 注入 9 条、逐条试放注入 17 条）。列表按 updated_at DESC，被挤掉的正是"较旧但仍相关"那批。
    if (total + line.length > MEMORY_INJECT_MAX_TOTAL_CHARS) continue
    lines.push(line)
    total += line.length
  }
  if (lines.length === 0) return ''
  return `## 用户记忆\n以下是关于该用户的长期记忆（偏好、事实、约定），回复时请参考并保持一致：\n${lines.join('\n')}`
}
