// MCP Server 配置导出（Claude Desktop 风格 mcpServers JSON），与 mcp-import 的解析对称。
//
// 安全默认：env/headers 中的敏感值（Authorization/API Key/Token 等）默认替换为 REDACTED——
// 便携场景配置文件可能随 U 盘丢失，换机导入后手动补密钥即可。
// 不导出 id/enabled/createdAt；runtime 不导出（导入端按 command basename 推断）；
// python 包名走 PocketAI 扩展键 x-pocketai-python-packages（标准客户端忽略未知键）。
import type { McpServerRecord } from './types'

/** 脱敏占位值：导入后为非空字符串（结构校验通过）但连接必然失败，强制用户手填 */
export const REDACTED_PLACEHOLDER = 'REDACTED'

/** 敏感键名匹配（大小写不敏感）：authorization / api-key（含 X-API-KEY 等前缀）/ token / secret / password / credential / bearer */
const SENSITIVE_KEY_RE = /authorization|api[_-]?key|token|secret|password|passwd|credential|bearer/i

/** PocketAI 扩展键：python 运行时的 pip 包列表（标准 mcpServers 格式无此字段） */
export const PYTHON_PACKAGES_KEY = 'x-pocketai-python-packages'

export interface McpExportEntry {
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>
  // http
  type?: 'http'
  url?: string
  headers?: Record<string, string>
  // 扩展
  [PYTHON_PACKAGES_KEY]?: string[]
}

export interface McpExportPayload {
  mcpServers: Record<string, McpExportEntry>
}

export interface McpExportResult extends McpExportPayload {
  /** 被脱敏的键值数量（UI 提示导入后需手填） */
  redactedCount: number
}

export interface McpExportOptions {
  /** 是否脱敏敏感值，默认 true */
  redactSecrets?: boolean
}

/** 复制一份字符串映射，命中敏感键时替换值；返 [新映射, 脱敏数] */
function redactRecord(
  rec: Record<string, string>,
  redact: boolean
): [Record<string, string>, number] {
  let n = 0
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec)) {
    if (redact && SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED_PLACEHOLDER
      n++
    } else {
      out[k] = v
    }
  }
  return [out, n]
}

/**
 * 导出记录列表为标准 mcpServers 载荷。
 * 同名记录（理论上不该有）后者覆盖前者；空 env/headers 省略键；
 * 禁用状态的服务同样导出（换机后用户自行启停，导入端默认 enabled=true）。
 */
export function buildMcpExportPayload(
  records: McpServerRecord[],
  opts: McpExportOptions = {}
): McpExportResult {
  const redact = opts.redactSecrets !== false
  const mcpServers: Record<string, McpExportEntry> = {}
  let redactedCount = 0

  for (const r of records) {
    if (r.transport === 'http') {
      const entry: McpExportEntry = { type: 'http', url: r.url ?? '' }
      if (Object.keys(r.headers).length > 0) {
        const [headers, n] = redactRecord(r.headers, redact)
        entry.headers = headers
        redactedCount += n
      }
      mcpServers[r.name] = entry
      continue
    }

    const entry: McpExportEntry = {
      command: r.command ?? '',
      args: r.args
    }
    if (Object.keys(r.env).length > 0) {
      const [env, n] = redactRecord(r.env, redact)
      entry.env = env
      redactedCount += n
    }
    if (r.runtime === 'python' && r.pythonPackages.length > 0) {
      entry[PYTHON_PACKAGES_KEY] = r.pythonPackages
    }
    mcpServers[r.name] = entry
  }

  return { mcpServers, redactedCount }
}
