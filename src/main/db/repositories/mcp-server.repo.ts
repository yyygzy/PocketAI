// MCP Server 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { McpServerRecord, McpTransport } from '../../../shared/types'

interface McpServerRow {
  id: string
  name: string
  transport: McpTransport
  command: string | null
  args: string | null // JSON 数组字符串
  env: string | null // JSON 对象字符串
  url: string | null
  enabled: number
  created_at: number
}

function rowToRecord(row: McpServerRow): McpServerRecord {
  let args: string[] = []
  let env: Record<string, string> = {}
  try {
    if (row.args) args = JSON.parse(row.args)
  } catch {
    args = []
  }
  try {
    if (row.env) env = JSON.parse(row.env)
  } catch {
    env = {}
  }
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    command: row.command,
    args,
    env,
    url: row.url,
    enabled: row.enabled === 1,
    createdAt: row.created_at
  }
}

export const mcpServerRepo = {
  list(): McpServerRecord[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM mcp_servers ORDER BY created_at ASC')
      .all() as McpServerRow[]
    return rows.map(rowToRecord)
  },

  get(id: string): McpServerRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM mcp_servers WHERE id=?')
      .get(id) as McpServerRow | undefined
    return row ? rowToRecord(row) : null
  },

  save(input: Partial<McpServerRecord> & { name: string }): McpServerRecord {
    const db = dbService.getHandle()
    const existing = input.id ? this.get(input.id) : null
    const id = input.id || randomUUID()

    if (existing) {
      db.prepare(
        `UPDATE mcp_servers SET
           name=?, transport=?, command=?, args=?, env=?, url=?, enabled=?
         WHERE id=?`
      ).run(
        input.name ?? existing.name,
        input.transport ?? existing.transport,
        input.command ?? existing.command,
        JSON.stringify(input.args ?? existing.args),
        JSON.stringify(input.env ?? existing.env),
        input.url ?? existing.url,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        id
      )
    } else {
      const now = Date.now()
      db.prepare(
        `INSERT INTO mcp_servers
           (id, name, transport, command, args, env, url, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.name,
        input.transport ?? 'stdio',
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.env ?? {}),
        input.url ?? null,
        input.enabled !== false ? 1 : 0,
        now
      )
    }
    return this.get(id)!
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM mcp_servers WHERE id=?').run(id)
  }
}
