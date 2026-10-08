// MCP Server 数据访问
//
// env / headers 是凭据载体（stdio 环境变量、http Authorization 头），整列字段级加密落盘；
// 出 IPC 一律掩码（见 handlers/mcp.ts），保存时按占位符回填原值，因此「只改命令不改密钥」
// 的保存不会把掩码写成真实值。密钥轮换由 credential-rotation 走 exportAllSecrets/restoreAllSecrets。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { mustGet } from '../must-get'
import { encryptSecretMap, decryptSecretMap, isCipherText } from '../../crypto/field-encrypt'
import { restoreMaskedMap } from '../../../shared/secret-mask'
import { createLogger } from '../../logger'
import { errMsg } from '../../error'
import type { McpServerRecord, McpTransport, McpRuntime } from '../../../shared/types'

const log = createLogger('crypto')

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
  headers?: string | null // JSON 对象字符串（v41 起；旧库可能无此列）
  trust_read_only?: number | null // 0/1（v44 起；旧库按未信任处理）
}

function rowToRecord(row: McpServerRow): McpServerRecord {
  let args: string[] = []
  let env: Record<string, string> = {}
  let headers: Record<string, string> = {}
  let pythonPackages: string[] = []
  try {
    if (row.args) args = JSON.parse(row.args)
  } catch {
    args = []
  }
  // env/headers 为字段级密文（v1:…）；decryptSecretMap 兼容历史明文 JSON 与损坏值（→ {}）
  env = decryptSecretMap(row.env)
  headers = decryptSecretMap(row.headers)
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
  // headers 仅在 http 传输下有意义，stdio 恒为 {}
  if (row.transport !== 'http') headers = {}
  return {
    id: row.id,
    name: row.name,
    transport: row.transport,
    runtime,
    command: row.command,
    args,
    env,
    url: row.url,
    headers,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    // v44 前的旧库无此列 → 一律按「不信任」处理（SEC-5 的默认必须偏保守）
    trustReadOnly: row.trust_read_only === 1,
    pythonPackages
  }
}

/** 保存前归一化：pythonPackages 仅 stdio+python 保留，元素强制为去空白字符串并丢弃空行；
 *  headers 仅 http 保留，key/value 去空白并丢弃空 key */
function normalizeInput(
  input: Partial<McpServerRecord> & { name: string },
  existing: McpServerRecord | null
): { transport: McpTransport; runtime: McpRuntime; pythonPackages: string[]; headers: Record<string, string> } {
  const transport = input.transport ?? existing?.transport ?? 'stdio'
  const runtime = input.runtime ?? existing?.runtime ?? 'binary'
  const rawPkgs = input.pythonPackages ?? existing?.pythonPackages ?? []
  const pythonPackages =
    transport === 'stdio' && runtime === 'python'
      ? rawPkgs.map((p) => String(p).trim()).filter(Boolean)
      : []
  const rawHeaders = input.headers ?? existing?.headers ?? {}
  const headers =
    transport === 'http'
      ? Object.fromEntries(
          Object.entries(rawHeaders)
            .map(([k, v]) => [k.trim(), String(v)] as const)
            .filter(([k]) => k.length > 0)
        )
      : {}
  return { transport, runtime, pythonPackages, headers }
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
    // 渲染层提交的是掩码视图：占位值回填原值，未提交则沿用原值（新增记录无原值 → 丢弃占位）
    const env =
      input.env !== undefined ? restoreMaskedMap(input.env, existing?.env) : (existing?.env ?? {})
    const headers =
      input.headers !== undefined
        ? restoreMaskedMap(input.headers, existing?.headers)
        : undefined
    const { transport, runtime, pythonPackages, headers: normalizedHeaders } = normalizeInput(
      { ...input, env, headers },
      existing
    )
    const envCipher = encryptSecretMap(env)
    const headersCipher = encryptSecretMap(normalizedHeaders)
    const trustReadOnly =
      input.trustReadOnly !== undefined ? (input.trustReadOnly ? 1 : 0) : existing?.trustReadOnly ? 1 : 0

    if (existing) {
      db.prepare(
        `UPDATE mcp_servers SET
           name=?, transport=?, runtime=?, command=?, args=?, env=?, url=?, enabled=?, python_packages=?, headers=?, trust_read_only=?
         WHERE id=?`
      ).run(
        input.name ?? existing.name,
        transport,
        runtime,
        input.command ?? existing.command,
        JSON.stringify(input.args ?? existing.args),
        envCipher,
        input.url ?? existing.url,
        input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0),
        JSON.stringify(pythonPackages),
        headersCipher,
        trustReadOnly,
        id
      )
    } else {
      const now = Date.now()
      db.prepare(
        `INSERT INTO mcp_servers
           (id, name, transport, runtime, command, args, env, url, enabled, created_at, python_packages, headers, trust_read_only)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        input.name,
        transport,
        runtime,
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        envCipher,
        input.url ?? null,
        input.enabled !== false ? 1 : 0,
        now,
        JSON.stringify(pythonPackages),
        headersCipher,
        trustReadOnly
      )
    }
    return mustGet(() => this.get(id), 'MCP Server')
  },

  delete(id: string): void {
    dbService.getHandle().prepare('DELETE FROM mcp_servers WHERE id=?').run(id)
  },

  /**
   * 历史明文 env/headers（JSON 明文、非 v1: 密文）→ 当前字段密钥密文的一次性升级（幂等）。
   * 必须在字段密钥可用时调用（DB 打开且解锁完成后，见 index.ts 阶段 3）。
   * 只动非密文列：已加密的行绝不经解密失败路径被回写空值（那才是真的丢数据）。
   */
  migratePlaintextSecrets(): void {
    const db = dbService.getHandle()
    const rows = db.prepare('SELECT id, env, headers FROM mcp_servers').all() as Pick<
      McpServerRow,
      'id' | 'env' | 'headers'
    >[]
    const stmtEnv = db.prepare('UPDATE mcp_servers SET env=? WHERE id=?')
    const stmtHeaders = db.prepare('UPDATE mcp_servers SET headers=? WHERE id=?')
    let upgraded = 0
    for (const row of rows) {
      if (row.env && !isCipherText(row.env)) {
        stmtEnv.run(encryptSecretMap(decryptSecretMap(row.env)), row.id)
        upgraded++
      }
      if (row.headers && !isCipherText(row.headers)) {
        stmtHeaders.run(encryptSecretMap(decryptSecretMap(row.headers)), row.id)
        upgraded++
      }
    }
    if (upgraded > 0) log.info(`MCP Server env/headers 已升级为字段加密: ${upgraded} 列`)
  },

  /** 轮换前（旧字段密钥仍可用）：导出全部 env/headers 明文快照，仅进程内存 */
  exportAllSecrets(): Record<string, { env: Record<string, string>; headers: Record<string, string> }> {
    const snapshot: Record<string, { env: Record<string, string>; headers: Record<string, string> }> = {}
    for (const row of this.list()) {
      if (Object.keys(row.env).length > 0 || Object.keys(row.headers).length > 0) {
        snapshot[row.id] = { env: row.env, headers: row.headers }
      }
    }
    return snapshot
  },

  /**
   * 轮换后（新字段密钥已生效）：用新密钥重加密并只改写 env/headers 两列。
   * 行已删除则跳过（不复活配置）；单行失败仅告警，不影响其余凭据。
   */
  restoreAllSecrets(
    snapshot: Record<string, { env: Record<string, string>; headers: Record<string, string> }>
  ): void {
    const db = dbService.getHandle()
    const stmt = db.prepare('UPDATE mcp_servers SET env=?, headers=? WHERE id=?')
    for (const [id, secrets] of Object.entries(snapshot)) {
      try {
        stmt.run(encryptSecretMap(secrets.env), encryptSecretMap(secrets.headers), id)
      } catch (e) {
        log.warn(`MCP 凭据轮换恢复失败 ${id}:`, errMsg(e))
      }
    }
  }
}
