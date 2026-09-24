// 用户记忆上下文构建：注入 SystemPrompt，让 LLM 感知用户偏好与事实
// 上限控制：条目数 + 单条长度 + 总字符，防止撑爆 token 窗口
import { userMemoryRepo } from '../db/repositories/user-memory.repo'

const MAX_MEMORIES = 50 // 最多注入条数
const MAX_ITEM_CHARS = 200 // 单条截断
const MAX_TOTAL_CHARS = 2000 // 总字符上限

export function buildMemoryContext(): string {
  const memories = userMemoryRepo.list()
  const items = memories
    .slice(0, MAX_MEMORIES)
    .map((m) => m.content.replace(/\s+/g, ' ').trim().slice(0, MAX_ITEM_CHARS))
    .filter(Boolean)
  if (items.length === 0) return ''

  const lines: string[] = []
  let total = 0
  for (const item of items) {
    const line = `- ${item}`
    if (total + line.length > MAX_TOTAL_CHARS) break
    lines.push(line)
    total += line.length
  }
  if (lines.length === 0) return ''
  return `## 用户记忆\n以下是关于该用户的长期记忆（偏好、事实、约定），回复时请参考并保持一致：\n${lines.join('\n')}`
}
