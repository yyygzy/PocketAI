// memory_save 内置工具：LLM 在对话中主动记住用户偏好/事实（写入 user_memory 表）。
// 用户可在设置页查看与删除；permission=auto（低风险：仅本地追加一条短文本）。
import { userMemoryRepo } from '../db/repositories/user-memory.repo'
import type { BuiltinTool } from './builtin'

const MAX_CONTENT_CHARS = 500

export const memorySaveTool: BuiltinTool = {
  schema: {
    id: 'memory.save',
    name: 'memory_save',
    description:
      '长期记忆：当用户表达个人偏好、背景事实，或明确要求"记住某事"时，把一句话记忆写入用户记忆库（如"用户偏好简洁回复"）。参数：content (string，一句话，用第三人称稳定表述)。禁止记录密码、密钥、详细住址等敏感信息。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容（一句话，第三人称表述）' }
      },
      required: ['content'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 3_000 // 本地 DB 追加
  },
  async execute(args) {
    const raw = typeof args?.content === 'string' ? args.content.trim() : ''
    if (!raw) throw new Error('content 不能为空')
    const content = raw.slice(0, MAX_CONTENT_CHARS)
    // 完全相同的内容跳过，避免 LLM 反复保存同一条
    const existing = userMemoryRepo.list().find((m) => m.content === content)
    if (existing) {
      return JSON.stringify({ ok: true, duplicate: true, id: existing.id, message: '该记忆已存在，未重复保存' })
    }
    const record = userMemoryRepo.add(content)
    return JSON.stringify({ ok: true, id: record.id, content: record.content })
  }
}
