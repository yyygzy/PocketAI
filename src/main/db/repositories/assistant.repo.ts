// Assistant 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { AssistantRecord } from '../../../shared/types'

interface AssistantRow {
  id: string
  name: string
  description: string | null
  avatar: string | null
  system_prompt: string | null
  default_provider_id: string | null
  default_model: string | null
  default_params: string | null
  tool_permissions: string | null
  skill_ids: string | null
  knowledge_base_ids: string | null
  welcome_message: string | null
  is_builtin: number
  is_pinned: number
  created_at: number
}

function safeArray(s: string | null): string[] {
  if (!s) return []
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function safeObject(s: string | null): Record<string, unknown> | null {
  if (!s) return null
  try {
    const v = JSON.parse(s)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

function rowToRecord(row: AssistantRow): AssistantRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    avatar: row.avatar ?? '🤖',
    systemPrompt: row.system_prompt ?? '',
    defaultProviderId: row.default_provider_id,
    defaultModel: row.default_model,
    defaultParams: safeObject(row.default_params),
    toolPermissions: safeArray(row.tool_permissions),
    skillIds: safeArray(row.skill_ids),
    knowledgeBaseIds: safeArray(row.knowledge_base_ids),
    welcomeMessage: row.welcome_message ?? '',
    isBuiltin: row.is_builtin === 1,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at
  }
}

/** 内置 JSON 文件载入后的结构 */
export type BuiltinAssistant = Omit<AssistantRecord, 'isBuiltin' | 'createdAt'>

export const assistantRepo = {
  list(): AssistantRecord[] {
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT * FROM assistants
         ORDER BY is_pinned DESC, created_at ASC, rowid ASC`
      )
      .all() as AssistantRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): AssistantRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM assistants WHERE id=?')
      .get(id) as AssistantRow | undefined
    return row ? rowToRecord(row) : null
  },

  /** 内置助手同步：以文件为准 upsert（首次插入 / 后续更新内容，不改用户自定义） */
  upsertBuiltin(a: BuiltinAssistant): void {
    const db = dbService.getHandle()
    const existing = this.get(a.id)
    const params = JSON.stringify(a.defaultParams)
    const tools = JSON.stringify(a.toolPermissions)
    const skills = JSON.stringify(a.skillIds)
    const kbIds = JSON.stringify(a.knowledgeBaseIds ?? [])

    if (existing) {
      // 内置同步：只更新非用户可配置字段，保留用户对 tool_permissions /
      // knowledge_base_ids / default_provider_id / default_model / default_params 的修改
      db.prepare(
        `UPDATE assistants SET
           name=?, description=?, avatar=?, system_prompt=?,
           welcome_message=?, is_builtin=1
         WHERE id=?`
      ).run(
        a.name, a.description, a.avatar, a.systemPrompt,
        a.welcomeMessage, a.id
      )
    } else {
      db.prepare(
        `INSERT INTO assistants
           (id, name, description, avatar, system_prompt, default_provider_id, default_model,
            default_params, tool_permissions, skill_ids, knowledge_base_ids, welcome_message, is_builtin, is_pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(
        a.id, a.name, a.description, a.avatar, a.systemPrompt,
        a.defaultProviderId, a.defaultModel, params, tools, skills, kbIds, a.welcomeMessage,
        a.isPinned ? 1 : 0, Date.now()
      )
    }
  },

  /** 新建（自定义助手）或保存对自定义助手的编辑 */
  save(input: Partial<AssistantRecord> & { name: string }): AssistantRecord {
    const db = dbService.getHandle()
    const id = input.id && this.get(input.id) ? input.id : randomUUID()
    const existing = this.get(id)
    if (existing?.isBuiltin) throw new Error('内置助手不可编辑，请先复制为我的助手')

    const record: AssistantRecord = {
      id,
      name: input.name,
      description: input.description ?? '',
      avatar: input.avatar ?? '🤖',
      systemPrompt: input.systemPrompt ?? '',
      defaultProviderId: input.defaultProviderId ?? null,
      defaultModel: input.defaultModel ?? null,
      defaultParams: input.defaultParams ?? null,
      toolPermissions: input.toolPermissions ?? [],
      skillIds: input.skillIds ?? [],
      knowledgeBaseIds: input.knowledgeBaseIds ?? existing?.knowledgeBaseIds ?? [],
      welcomeMessage: input.welcomeMessage ?? '',
      isBuiltin: false,
      isPinned: input.isPinned ?? existing?.isPinned ?? false,
      createdAt: existing?.createdAt ?? Date.now()
    }

    if (existing) {
      db.prepare(
        `UPDATE assistants SET name=?, description=?, avatar=?, system_prompt=?,
           default_provider_id=?, default_model=?, default_params=?, tool_permissions=?,
           skill_ids=?, knowledge_base_ids=?, welcome_message=?, is_pinned=? WHERE id=?`
      ).run(
        record.name, record.description, record.avatar, record.systemPrompt,
        record.defaultProviderId, record.defaultModel, JSON.stringify(record.defaultParams),
        JSON.stringify(record.toolPermissions), JSON.stringify(record.skillIds),
        JSON.stringify(record.knowledgeBaseIds), record.welcomeMessage, record.isPinned ? 1 : 0, id
      )
    } else {
      db.prepare(
        `INSERT INTO assistants
           (id, name, description, avatar, system_prompt, default_provider_id, default_model,
            default_params, tool_permissions, skill_ids, knowledge_base_ids, welcome_message, is_builtin, is_pinned, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
      ).run(
        id, record.name, record.description, record.avatar, record.systemPrompt,
        record.defaultProviderId, record.defaultModel, JSON.stringify(record.defaultParams),
        JSON.stringify(record.toolPermissions), JSON.stringify(record.skillIds),
        JSON.stringify(record.knowledgeBaseIds), record.welcomeMessage,
        record.isPinned ? 1 : 0, record.createdAt
      )
    }
    return this.get(id)!
  },

  /** 复制任意助手为「我的助手」 */
  duplicate(sourceId: string): AssistantRecord {
    const src = this.get(sourceId)
    if (!src) throw new Error('助手不存在')
    return this.save({
      name: `${src.name} 副本`,
      description: src.description,
      avatar: src.avatar,
      systemPrompt: src.systemPrompt,
      defaultProviderId: src.defaultProviderId,
      defaultModel: src.defaultModel,
      defaultParams: src.defaultParams,
      toolPermissions: src.toolPermissions,
      skillIds: src.skillIds,
      knowledgeBaseIds: src.knowledgeBaseIds,
      welcomeMessage: src.welcomeMessage,
      isPinned: false
    })
  },

  setPinned(id: string, pinned: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE assistants SET is_pinned=? WHERE id=?')
      .run(pinned ? 1 : 0, id)
  },

  delete(id: string): void {
    const existing = this.get(id)
    if (!existing) return
    if (existing.isBuiltin) throw new Error('内置助手不可删除')
    dbService.getHandle().prepare('DELETE FROM assistants WHERE id=?').run(id)
  }
}
