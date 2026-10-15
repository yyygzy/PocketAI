// Conversation 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import type { ConversationRecord } from '../../../shared/types'

interface ConversationRow {
  id: string
  assistant_id: string | null
  title: string | null
  model: string | null
  params: string | null
  status: string | null
  created_at: number
  updated_at: number
  pinned?: number
  archived?: number
  archived_at?: number | null
  title_default?: number
  /** 列表预览列（仅 list 查询带出）：最新一条消息内容截断 */
  last_preview?: string | null
  /** 列表预览列（仅 list 查询带出）：是否有未发送草稿 */
  has_draft?: number
  /** v37：所属分组文件夹 id；NULL=未分组 */
  group_id?: string | null
  /** v38：会话备注；NULL=无备注 */
  note?: string | null
  /** v39：系统提示词覆盖；NULL=使用助手默认 */
  system_prompt_override?: string | null
  /** v48：子代理会话的父会话 id；NULL=用户自己的会话 */
  parent_conversation_id?: string | null
  /** v48：本会话承担的角色；NULL=无角色（用户会话） */
  role_key?: string | null
}

export function rowToRecord(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    title: row.title ?? '新对话',
    modelLabel: row.model,
    status: row.status ?? 'idle',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pinned: !!row.pinned,
    archived: !!row.archived,
    archivedAt: row.archived_at ?? null,
    titleDefault: row.title_default !== 0,
    lastMessagePreview: row.last_preview ?? null,
    hasDraft: !!row.has_draft,
    groupId: row.group_id ?? null,
    note: row.note ?? null,
    systemPromptOverride: row.system_prompt_override ?? null,
    parentConversationId: row.parent_conversation_id ?? null,
    roleKey: row.role_key ?? null
  }
}

/** list 查询条件拼装（纯函数，便于单测） */
export interface ConvListArgs {
  assistantId?: string
  isAgent?: boolean
  /** true=只取归档；false/undefined=只取活跃（默认） */
  archivedOnly?: boolean
  /**
   * 是否带出子代理会话（144：委派出去的子 run 各占一条独立会话）。
   * **默认 false**：委派一跑就多出几条机器会话，用户的会话列表会被灌满；
   * 需要看子会话时显式传 true（或按 id 直取 `get()`，那条不受这里影响）。
   */
  includeSubSessions?: boolean
}

export function buildConvListQuery(args: ConvListArgs): { where: string; vals: unknown[]; orderBy: string } {
  const conds: string[] = []
  const vals: unknown[] = []
  conds.push(args.archivedOnly ? 'archived = 1' : 'archived = 0')
  if (!args.includeSubSessions) conds.push('parent_conversation_id IS NULL')
  if (args.assistantId === 'asst-default') {
    conds.push("(assistant_id = 'asst-default' OR assistant_id IS NULL)")
  } else if (args.assistantId) {
    conds.push('assistant_id = ?')
    vals.push(args.assistantId)
  }
  if (args.isAgent === true) {
    conds.push("model LIKE 'agent:%'")
  } else if (args.isAgent === false) {
    conds.push("(model NOT LIKE 'agent:%' OR model IS NULL)")
  }
  const orderBy = args.archivedOnly
    ? 'pinned DESC, archived_at DESC, updated_at DESC'
    : 'pinned DESC, updated_at DESC'
  return { where: ' WHERE ' + conds.join(' AND '), vals, orderBy }
}

export const conversationRepo = {
  /** 列出会话；assistantId 给定时按助手归集；isAgent 控制是否只列 Agent 会话；archivedOnly 切换归档区；
   *  includeSubSessions 默认 false ⇒ 子代理会话不进列表（见 ConvListArgs 上的说明）。
   *  单条 SQL 关联子查询带出最新一条消息预览（80 字符、换行折叠为空格），避免逐会话 N+1 查询 */
  list(
    assistantId?: string,
    isAgent?: boolean,
    opts: { archivedOnly?: boolean; includeSubSessions?: boolean } = {}
  ): ConversationRecord[] {
    const { where, vals, orderBy } = buildConvListQuery({
      assistantId,
      isAgent,
      archivedOnly: opts.archivedOnly,
      includeSubSessions: opts.includeSubSessions
    })
    const rows = dbService
      .getHandle()
      .prepare(
        `SELECT c.*, (
           SELECT substr(replace(replace(m.content, char(13), ' '), char(10), ' '), 1, 80)
           FROM messages m
           WHERE m.conversation_id = c.id
           ORDER BY m.created_at DESC, m.rowid DESC
           LIMIT 1
         ) AS last_preview,
         EXISTS(SELECT 1 FROM conversation_drafts d WHERE d.conversation_id = c.id) AS has_draft
         FROM conversations c${where} ORDER BY ${orderBy}`
      )
      .all(...vals) as ConversationRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): ConversationRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM conversations WHERE id = ?')
      .get(id) as ConversationRow | undefined
    return row ? rowToRecord(row) : null
  },

  create(
    input: {
      assistantId?: string | null
      title?: string
      modelLabel?: string
      titleDefault?: boolean
      /** 144：子代理会话的父会话 id；空串按"没有父"处理（存出空串会永远匹配不上） */
      parentConversationId?: string | null
      /** 144：子代理角色（researcher/writer/reviewer…）；用户自己的会话不传 */
      roleKey?: string | null
    } = {}
  ): ConversationRecord {
    const now = Date.now()
    const id = randomUUID()
    // 新建会话默认标题仍是占位（titleDefault=1）；导入/恢复的会话传 false 视为已定稿
    const titleDefault = input.titleDefault === false ? 0 : 1
    const parent = input.parentConversationId?.trim() || null
    const role = input.roleKey?.trim() || null
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO conversations (id, assistant_id, title, model, params, status, created_at, updated_at, title_default, parent_conversation_id, role_key)
         VALUES (?, ?, ?, ?, NULL, 'idle', ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.assistantId ?? null,
        input.title ?? '新对话',
        input.modelLabel ?? null,
        now,
        now,
        titleDefault,
        parent,
        role
      )
    return mustGet(() => this.get(id), '会话')
  },

  /** 直接子会话 id（144：删父前用它的条数写确认文案，级联删除也走它） */
  childIds(parentId: string): string[] {
    return (
      dbService
        .getHandle()
        .prepare('SELECT id FROM conversations WHERE parent_conversation_id=?')
        .all(parentId) as Array<{ id: string }>
    ).map((r) => r.id)
  },

  /**
   * 整棵子树的会话 id（不含自己）。逐层展开而不是递归 CTE：委派树最多两三层，
   * 而循环里每层一次查询在 SQLite 侧更好核对（也避免旧版 SQLite 不支持 WITH RECURSIVE 的坑）。
   */
  descendantIds(rootId: string): string[] {
    const out: string[] = []
    let frontier = this.childIds(rootId)
    while (frontier.length > 0) {
      out.push(...frontier)
      const next: string[] = []
      for (const id of frontier) next.push(...this.childIds(id))
      frontier = next
    }
    return out
  },

  /**
   * 改归属助手（assistantId=null=自由会话）。分组按助手维度过滤，跨助手移动必须清 group_id，
   * 否则会话会挂在原助手的文件夹里、在新助手下列表看不见。不改标题/时间以外的内容字段。
   */
  setAssistant(id: string, assistantId: string | null): boolean {
    const info = dbService
      .getHandle()
      .prepare('UPDATE conversations SET assistant_id=?, group_id=NULL, updated_at=? WHERE id=?')
      .run(assistantId, Date.now(), id)
    return info.changes > 0
  },

  /** 重命名标题同时视为定稿，后续不再自动命名 */
  rename(id: string, title: string): void {
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET title=?, title_default=0, updated_at=? WHERE id=?')
      .run(title, Date.now(), id)
  },

  /** 仅消费「占位标题」标记（不改标题）：开关关闭且占位标题不是「新对话」时使用 */
  setTitleDefault(id: string, isDefault: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET title_default=? WHERE id=?')
      .run(isDefault ? 1 : 0, id)
  },

  setPinned(id: string, pinned: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET pinned=? WHERE id=?')
      .run(pinned ? 1 : 0, id)
  },

  /** 备注：trim 后空串存 NULL；不动 updated_at（备注不改变活跃排序） */
  setNote(id: string, note: string | null): void {
    const v = note?.trim() || null
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET note=? WHERE id=?')
      .run(v, id)
  },

  /** 系统提示词覆盖：trim 后空串存 NULL（恢复默认）；不动 updated_at（不改变活跃排序） */
  setSystemPromptOverride(id: string, text: string | null): void {
    const v = text?.trim() || null
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET system_prompt_override=? WHERE id=?')
      .run(v, id)
  },

  /** 归档写 archived_at；取消归档清空。不动 pinned（恢复后保持原置顶态） */
  setArchived(id: string, archived: boolean): void {
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET archived=?, archived_at=? WHERE id=?')
      .run(archived ? 1 : 0, archived ? Date.now() : null, id)
  },

  touch(id: string, patch: { modelLabel?: string; status?: string } = {}): void {
    // 归档会话重新活跃（收到消息/状态变化）自动回到主列表
    const sets = ['updated_at=?', 'archived=0', 'archived_at=NULL']
    const vals: unknown[] = [Date.now()]
    if (patch.modelLabel !== undefined) {
      sets.push('model=?')
      vals.push(patch.modelLabel)
    }
    if (patch.status !== undefined) {
      sets.push('status=?')
      vals.push(patch.status)
    }
    vals.push(id)
    dbService
      .getHandle()
      .prepare(`UPDATE conversations SET ${sets.join(', ')} WHERE id=?`)
      .run(...vals)
  },

  delete(id: string): void {
    const db = dbService.getHandle()
    // 先取子树：删掉父会话时，委派出去的子代理会话不能变成孤儿（它们不在列表里，
    // 留着的后果是"看不见却占着库、还计入会话统计"）。级联口径已在方案 §144 记档。
    const doomed = [id, ...this.descendantIds(id)]
    const tx = db.transaction(() => {
      for (const cid of doomed) {
        // 级联删除消息（FTS 触发器自动同步）
        db.prepare('DELETE FROM messages WHERE conversation_id=?').run(cid)
        db.prepare('DELETE FROM messages_fts WHERE conversation_id=?').run(cid)
        // 级联删除未发送草稿
        db.prepare('DELETE FROM conversation_drafts WHERE conversation_id=?').run(cid)
        db.prepare('DELETE FROM conversations WHERE id=?').run(cid)
      }
    })
    tx()
  },

  /** 读取会话未发送草稿；无草稿返回空串 */
  getDraft(id: string): string {
    const row = dbService
      .getHandle()
      .prepare('SELECT draft FROM conversation_drafts WHERE conversation_id=?')
      .get(id) as { draft: string } | undefined
    return row?.draft ?? ''
  },

  /** 保存草稿（UPSERT）；空串删除草稿行（发送后/手动清空） */
  setDraft(id: string, text: string): void {
    const handle = dbService.getHandle()
    if (!text) {
      handle.prepare('DELETE FROM conversation_drafts WHERE conversation_id=?').run(id)
      return
    }
    handle
      .prepare(
        `INSERT INTO conversation_drafts (conversation_id, draft, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET draft = excluded.draft, updated_at = excluded.updated_at`
      )
      .run(id, text, Date.now())
  },

  /**
   * 空会话守卫删除：仅删除「自动标题 + 未置顶 + 0 消息 + 0 草稿」的行。
   * 守卫保证无消息/无草稿，无需走 delete() 的事务级联；返回是否真的删到。
   * 切会话时由渲染端对前一个会话调用，防止点「新对话」未发消息即切走堆积空壳。
   */
  deleteIfEmpty(id: string): boolean {
    const res = dbService
      .getHandle()
      .prepare(
        `DELETE FROM conversations
         WHERE id=? AND title_default=1 AND pinned=0
           AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)
           AND NOT EXISTS (SELECT 1 FROM conversation_drafts WHERE conversation_id = conversations.id)`
      )
      .run(id) as { changes: number }
    return res.changes > 0
  },

  /**
   * 全局清扫空会话（启动时调用）：活跃/归档区一并清理——
   * 0 内容 + 自动标题 + 未置顶的归档空行同样是垃圾；返回删除条数。
   */
  cleanupEmptyConversations(): number {
    const res = dbService
      .getHandle()
      .prepare(
        `DELETE FROM conversations
         WHERE title_default=1 AND pinned=0
           AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = conversations.id)
           AND NOT EXISTS (SELECT 1 FROM conversation_drafts WHERE conversation_id = conversations.id)`
      )
      .run() as { changes: number }
    return res.changes
  },

  /**
   * 消息分支：复制源会话中截至 upToMessageId（含该消息）的全部消息到新会话。
   * - 消息按 created_at/rowid 线性截取前缀（含 user/assistant/tool/system）
   * - 全部消息生成新 UUID，parent_id 按 oldId→newId 映射重写
   * - 保留 tool_calls / attachments / created_at；FTS 由触发器自动同步
   */
  fork(srcConversationId: string, upToMessageId: string): ConversationRecord {
    const db = dbService.getHandle()
    const src = this.get(srcConversationId)
    if (!src) throw new Error('源会话不存在')

    const tx = db.transaction((): ConversationRecord => {
      const all = db
        .prepare('SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at ASC, rowid ASC')
        .all(srcConversationId) as Array<{
          id: string
          role: string
          content: string | null
          provider: string | null
          model: string | null
          status: string | null
          parent_id: string | null
          created_at: number
          tool_calls: string | null
          attachments: string | null
          batch_id: string | null
        }>
      const cutIdx = all.findIndex((m) => m.id === upToMessageId)
      if (cutIdx === -1) throw new Error('分支起点消息不存在')
      const subset = all.slice(0, cutIdx + 1)

      const now = Date.now()
      const newConvId = randomUUID()
      db.prepare(
        `INSERT INTO conversations (id, assistant_id, title, model, params, status, created_at, updated_at, title_default, system_prompt_override)
         VALUES (?, ?, ?, ?, NULL, 'idle', ?, ?, 0, ?)`
      ).run(
        newConvId,
        src.assistantId,
        `${src.title || '新对话'} (分支)`,
        src.modelLabel,
        now,
        now,
        src.systemPromptOverride
      )

      const idMap = new Map<string, string>()
      const insertMsg = db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider, model, status, parent_id, created_at, tool_calls, attachments, batch_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      for (const m of subset) {
        const newMsgId = randomUUID()
        idMap.set(m.id, newMsgId)
        const newParent = m.parent_id ? idMap.get(m.parent_id) ?? null : null
        insertMsg.run(
          newMsgId,
          newConvId,
          m.role,
          m.content,
          m.provider,
          m.model,
          m.status ?? 'done',
          newParent,
          m.created_at,
          m.tool_calls ?? null,
          m.attachments ?? null,
          m.batch_id ?? null
        )
      }
      return mustGet(() => this.get(newConvId), '会话副本')
    })
    return tx()
  }
}
