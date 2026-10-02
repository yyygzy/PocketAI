// 会话分组文件夹 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { ConversationGroupRecord } from '../../../shared/types'

interface GroupRow {
  id: string
  assistant_id: string | null
  name: string
  created_at: number
}

function rowToRecord(row: GroupRow): ConversationGroupRecord {
  return {
    id: row.id,
    assistantId: row.assistant_id,
    name: row.name,
    createdAt: row.created_at
  }
}

/**
 * 组列表助手过滤拼装（与会话列表同口径）：
 * asst-default 同时取 NULL 归属；其他助手精确匹配；undefined=不加助手条件。
 * 导出纯函数便于单测。
 */
export function buildGroupListWhere(assistantId?: string): { where: string; vals: unknown[] } {
  if (assistantId === 'asst-default') {
    return { where: " WHERE (assistant_id = 'asst-default' OR assistant_id IS NULL)", vals: [] }
  }
  if (assistantId) {
    return { where: ' WHERE assistant_id = ?', vals: [assistantId] }
  }
  return { where: '', vals: [] }
}

export const conversationGroupRepo = {
  /** 列出某助手维度的全部分组（按创建时间正序；前端再按组内最近会话排序） */
  list(assistantId?: string): ConversationGroupRecord[] {
    const { where, vals } = buildGroupListWhere(assistantId)
    const rows = dbService
      .getHandle()
      .prepare(`SELECT id, assistant_id, name, created_at FROM conversation_groups${where} ORDER BY created_at ASC`)
      .all(...vals) as GroupRow[]
    return rows.map(rowToRecord)
  },

  /** 新建分组：name 由 IPC 层保证 trim 后 1-40 字 */
  create(input: { assistantId?: string | null; name: string }): ConversationGroupRecord {
    const id = randomUUID()
    const now = Date.now()
    dbService
      .getHandle()
      .prepare('INSERT INTO conversation_groups (id, assistant_id, name, created_at) VALUES (?, ?, ?, ?)')
      .run(id, input.assistantId ?? null, input.name, now)
    return { id, assistantId: input.assistantId ?? null, name: input.name, createdAt: now }
  },

  rename(id: string, name: string): void {
    dbService.getHandle().prepare('UPDATE conversation_groups SET name=? WHERE id=?').run(name, id)
  },

  /**
   * 解散分组：先把组内会话全部移回未分组，再删组（事务原子）。
   * 只解散文件夹，绝不删除会话内容。
   */
  delete(id: string): void {
    const handle = dbService.getHandle()
    const tx = handle.transaction(() => {
      handle.prepare('UPDATE conversations SET group_id=NULL WHERE group_id=?').run(id)
      handle.prepare('DELETE FROM conversation_groups WHERE id=?').run(id)
    })
    tx()
  },

  /** 移动会话到分组；groupId=null 表示移出分组回到顶层 */
  setConversationGroup(convId: string, groupId: string | null): void {
    dbService
      .getHandle()
      .prepare('UPDATE conversations SET group_id=? WHERE id=?')
      .run(groupId, convId)
  }
}
