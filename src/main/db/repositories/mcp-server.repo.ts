// MCP Server 数据访问
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import type { McpServerRecord, McpTransport, McpRuntime } from '../../../shared/types'

interface McpServerRow {
  id: string
  name: string
  transport: McpTransport
  runtime: McpRuntime
  command: string | null
  args: string | null // JSON 数组字符串
  env: string | null // JSON 对象字符串
  url: string | null
  enabled: number
  created_at: number
  python_packages?: string | null // JSON 字符串数组（v16 起；旧库可能无此列）
}

function rowToRecord(row: McpServerRow): McpServerRecord {
  let args: string[] = []
  let env: Record<string, string> = {}
  let pythonPackages: string[] = []
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
  try {
    if (row.python_packages) {
      const parsed: unknown = JSON.parse(row.python_packages)
      // 库内容可能被外部工具篡改为非数组 JSON：必须兜底，否则渲染端 .join 会崩
      pythonPackages = Array.isArray(parsed) ? parsed.map((x) => String(x)) : []
    }
  } catch {
    pythonPackages = []
  }
  // pythonPackages 仅在 stdio + python 运行时下有意义，其余恒为 []
  const runtime = row.runtime ?? 'binary'
  if (row.transport !== 'stdio' || runtime !== 'python') pythonPackages = []
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    runtime,
    command: row.command,
    args,
    env,
    url: row.url,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    pythonPackages
  }
}

/** 保存前归一化：pythonPackages 仅 stdio+python 保留，元素强制为去空白字符串并丢弃空行 */
function normalizeInput(
  input: Partial<McpServerRecord> & { name: string },
  existing: McpServerRecord | null
): { transport: McpTransport; runtime: McpRuntime; pythonPackages: string[] } {
  const transport = input.transport ?? existing?.transport ?? 'stdio'
  const runtime = input.runtime ?? existing?.runtime ?? 'binary'
  const rawPkgs = input.pythonPackages ?? existing?.pythonPackages ?? []
  const pythonPackages =
    transport === 'stdio' && runtime === 'python'
      ? rawPkgs.map((p) => String(p).trim()).filter(Boolean)
      : []
  return { transport, runtime, pythonPackages }
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
    const { transport, runtime, pythonPackages } = normalizeInput(input, existing)

    if (existing) {
      db.prepare(
        `UPDATE mcp_servers SET
           name=?, transport=?, runtime=?, command=?, args=?, env=?, url=?, enabled=?, python_packages=?
         WHERE id=?`
      ).run(
        input.name ?? existing.name,
        transport,
        runtime,
        input.command ?? existing.command,
        JSON.stringify(input.args ?? existing.args),
        JSON.stringify(input.env ?? existing.env),
        input.url ?? existing.url,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        JSON.stringify(pythonPackages),
        id
      )
    } else {
      const now = Date.now()
      db.prepare(
        `INSERT INTO mcp_servers
           (id, name, transport, runtime, command, args, env, url, enabled, created_at, python_packages)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.name,
        transport,
        runtime,
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.env ?? {}),
        input.url ?? null,
        input.enabled !== false ? 1 : 0,
        now,
        JSON.stringify(pythonPackages)
      )
    }
    return this.get(id)!
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM mcp_servers WHERE id=?').run(id)
  }
}
