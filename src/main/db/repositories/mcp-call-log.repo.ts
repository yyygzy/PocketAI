// MCP 工具调用记录数据访问（v45 表 mcp_call_log）
//
// 与 agent_traces 的分工：那张表按 Agent 请求记步骤耗时（谁的哪一轮慢），
// 这张按 server 记每次工具调用（含 MCP 面板的试运行，那条链路不经过 Agent 步骤），
// 回答的是「这个 server 昨晚被调了什么、返了什么、成没成」。
import { dbService } from '../database'
import { z } from 'zod'
import type { McpCallEvent, McpCallLogRecord } from '../../../shared/types'

/** server id 与 mcp_servers 同形状（UUID），复用长度校验避免空串拼进 SQL */
const serverIdSchema = z.string().min(1).max(64)

/** 每个 server 环形保留的条数上限：够回看最近一段，又不至于让库无限长 */
export const KEEP_PER_SERVER = 200
/** list 的默认与最大返回条数 */
export const DEFAULT_LIST_LIMIT = 200
export const MAX_LIST_LIMIT = 1000

interface McpCallLogRow {
  id: number
  server_id: string
  tool: string
  ok: number
  duration_ms: number
  args_preview: string | null
  result_preview: string | null
  error: string | null
  created_at: number
}

function rowToRecord(row: McpCallLogRow): McpCallLogRecord {
  return {
    id: row.id,
    serverId: row.server_id,
    tool: row.tool,
    ok: row.ok === 1,
    durationMs: row.duration_ms,
    argsPreview: row.args_preview ?? null,
    resultPreview: row.result_preview ?? null,
    error: row.error ?? null,
    createdAt: row.created_at
  }
}

export const mcpCallLogRepo = {
  /** 写入一条并裁剪到每 server 上限（同一事务，避免裁剪失败留下超长表） */
  append(evt: McpCallEvent): void {
    const db = dbService.getHandle()
    const serverId = serverIdSchema.parse(evt.serverId)
    const created_at = Date.now()
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO mcp_call_log
         (server_id, tool, ok, duration_ms, args_preview, result_preview, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        serverId,
        evt.tool.slice(0, 128),
        evt.ok ? 1 : 0,
        Math.max(0, Math.round(evt.durationMs)),
        evt.argsPreview,
        evt.resultPreview,
        evt.error,
        created_at
      )
      db.prepare(
        `DELETE FROM mcp_call_log
         WHERE server_id = ? AND id NOT IN (
           SELECT id FROM mcp_call_log WHERE server_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         )`
      ).run(serverId, serverId, KEEP_PER_SERVER)
    })
    tx()
  },

  /** 按 server 取最近记录（时间倒序）；serverId 为空=全部 */
  list(serverId?: string | null, limit: number = DEFAULT_LIST_LIMIT): McpCallLogRecord[] {
    // 非正数/NaN 一律用默认条数：夹成 1 条会让面板看起来「记录被删了」，比报错更难查
    const wanted = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_LIST_LIMIT
    const capped = Math.min(Math.max(1, wanted), MAX_LIST_LIMIT)
    const db = dbService.getHandle()
    if (serverId) {
      const rows = db
        .prepare('SELECT * FROM mcp_call_log WHERE server_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
        .all(serverIdSchema.parse(serverId), capped) as McpCallLogRow[]
      return rows.map(rowToRecord)
    }
    const rows = db
      .prepare('SELECT * FROM mcp_call_log ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(capped) as McpCallLogRow[]
    return rows.map(rowToRecord)
  },

  /** 清空记录：传 serverId 只清该 server，否则全清；返回删除条数 */
  clear(serverId?: string | null): number {
    const db = dbService.getHandle()
    if (serverId) {
      return db
        .prepare('DELETE FROM mcp_call_log WHERE server_id = ?')
        .run(serverIdSchema.parse(serverId)).changes
    }
    return db.prepare('DELETE FROM mcp_call_log').run().changes
  },
}
