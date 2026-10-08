// MCP Server 配置导出（Claude Desktop 风格 mcpServers JSON），与 mcp-import 的解析对称。
//
// 安全默认：env/headers 中的敏感值默认替换为 REDACTED——判定同时看键名（authorization/token/…）
// 与值的形态（sk-/ghp_/Bearer/高熵串），因为键名由用户或模板自填，`KEY_1`/`X-Auth` 会躲过键名匹配。
// 便携场景配置文件可能随 U 盘丢失，换机导入后按 x-pocketai-redacted-keys 清单手动补密钥即可。
// 不导出 id/enabled/createdAt；runtime 不导出（导入端按 command basename 推断）；
// python 包名走 PocketAI 扩展键 x-pocketai-python-packages（标准客户端忽略未知键）。
import type { McpServerRecord } from './types'

/** 脱敏占位值：导入后为非空字符串（结构校验通过）但连接必然失败，强制用户手填 */
export const REDACTED_PLACEHOLDER = 'REDACTED'

/** 敏感键名匹配（大小写不敏感）：authorization / api-key（含 X-API-KEY 等前缀）/ token / secret / password / credential / bearer */
const SENSITIVE_KEY_RE = /authorization|api[_-]?key|token|secret|password|passwd|credential|bearer/i

/**
 * 值侧识别（键名不可信——`KEY_1` / `GH_PAT` / `X-Auth` 都躲过键名匹配）：
 * - 已知厂商 token 形态（sk-/ghp_/xox/AKIA/AIza/ya29./ntn_ 等）；
 * - `Bearer <12+ 非空白>`；
 * - 24+ 位「无空白且同时含大小写与数字」的高熵串（路径/URL/普通配置难以命中）。
 */
const KNOWN_TOKEN_VALUE_RE =
  /^(?:sk-[A-Za-z0-9_\-.]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|xox[baprs]-[A-Za-z0-9\-]{6,}|AKIA[0-9A-Z]{8,}|AIza[0-9A-Za-z_\-.]{10,}|ya29\.[0-9A-Za-z_\-.]{6,}|ntn_[0-9A-Za-z]{8,})$/
const HIGH_ENTROPY_RE = /^[A-Za-z0-9_\-.+/=]{24,}$/
const BEARER_VALUE_RE = /^Bearer\s+\S{12,}$/i

/** 值是否形似凭据（空值/明显配置值返回 false） */
export function looksLikeSecret(value: string): boolean {
  const v = String(value ?? '').trim()
  if (!v) return false
  if (KNOWN_TOKEN_VALUE_RE.test(v)) return true
  if (BEARER_VALUE_RE.test(v)) return true
  if (HIGH_ENTROPY_RE.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v) && /\d/.test(v)) return true
  return false
}

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
  /** 被脱敏的条目，形如 `fs>API_KEY` / `remote>authorization`，供导出文件与 UI 逐项提示 */
  redactedEntries: string[]
}

export interface McpExportOptions {
  /** 是否脱敏敏感值，默认 true */
  redactSecrets?: boolean
}

/** 导出文件里的脱敏清单扩展键（标准客户端忽略未知键，PocketAI 用于提示需补哪些密钥） */
export const REDACTED_KEYS_NOTE = 'x-pocketai-redacted-keys'

/** 复制一份字符串映射，命中敏感键名或形似凭据的值时替换；返 [新映射, 脱敏键列表] */
function redactRecord(
  rec: Record<string, string>,
  redact: boolean
): [Record<string, string>, string[]] {
  const out: Record<string, string> = {}
  const hit: string[] = []
  for (const [k, v] of Object.entries(rec)) {
    if (redact && (SENSITIVE_KEY_RE.test(k) || looksLikeSecret(v))) {
      out[k] = REDACTED_PLACEHOLDER
      hit.push(k)
    } else {
      out[k] = v
    }
  }
  return [out, hit]
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
  const redactedEntries: string[] = []

  for (const r of records) {
    if (r.transport === 'http') {
      const entry: McpExportEntry = { type: 'http', url: r.url ?? '' }
      if (Object.keys(r.headers).length > 0) {
        const [headers, hits] = redactRecord(r.headers, redact)
        entry.headers = headers
        redactedEntries.push(...hits.map((k) => `${r.name}>${k}`))
      }
      mcpServers[r.name] = entry
      continue
    }

    const entry: McpExportEntry = {
      command: r.command ?? '',
      args: r.args
    }
    if (Object.keys(r.env).length > 0) {
      const [env, hits] = redactRecord(r.env, redact)
      entry.env = env
      redactedEntries.push(...hits.map((k) => `${r.name}>${k}`))
    }
    if (r.runtime === 'python' && r.pythonPackages.length > 0) {
      entry[PYTHON_PACKAGES_KEY] = r.pythonPackages
    }
    mcpServers[r.name] = entry
  }

  return { mcpServers, redactedCount: redactedEntries.length, redactedEntries }
}
