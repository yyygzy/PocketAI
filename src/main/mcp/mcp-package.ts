// MCP 配置包完整性（P2-3）：与技能包同一口径。
//
// 口径同技能包：**sha256 只证明「内容与导出时一致」，不证明「来源可信」，也不等于签名**。
// 校验和只覆盖 mcpServers 本体——不含 exportedAt、不含脱敏清单扩展键，
// 因为后两者是导出动作的元数据，不同时刻导出同一批配置必须得到同一个值。
//
// 归一化按服务名排序、条目字段固定顺序、env/headers 键排序：
// 让「同一份配置换个键序」不会被误判成被改动。
import { createHash } from 'node:crypto'
import {
  PYTHON_PACKAGES_KEY,
  REDACTED_KEYS_NOTE,
  type McpExportEntry
} from '../../shared/mcp-export'

export const MCP_PACKAGE_FORMAT = 'pocketai-mcp'
export const MCP_PACKAGE_VERSION = 1
export const MCP_CHECKSUM_ALGO = 'sha256'
/** 导入文件上限：MCP 配置是文本，512KB 足够宽裕 */
export const MCP_MAX_IMPORT_BYTES = 512 * 1024

export interface McpPackageChecksum {
  algo: string
  value: string
}

function sortedPairs(raw: unknown): Array<[string, string]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  const rec = raw as Record<string, unknown>
  return Object.keys(rec)
    .sort()
    .map((k) => [k, String(rec[k])] as [string, string])
}

/** 固定顺序重建：导出端与校验端共用，否则两边算出的值不可能对上 */
function canonicalServers(servers: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(servers)
      .sort()
      .map((name) => {
        const raw = servers[name]
        const e =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : ({} as Record<string, unknown>)
        const pkgs = e[PYTHON_PACKAGES_KEY]
        return [
          name,
          {
            type: typeof e.type === 'string' ? e.type : '',
            command: typeof e.command === 'string' ? e.command : '',
            args: Array.isArray(e.args) ? e.args.map(String) : [],
            env: sortedPairs(e.env),
            url: typeof e.url === 'string' ? e.url : '',
            headers: sortedPairs(e.headers),
            packages: Array.isArray(pkgs) ? pkgs.map(String) : []
          }
        ]
      })
  )
}

export function computeMcpChecksum(servers: Record<string, unknown>): McpPackageChecksum {
  return {
    algo: MCP_CHECKSUM_ALGO,
    value: createHash('sha256').update(canonicalServers(servers), 'utf8').digest('hex')
  }
}

export interface McpPackageFile {
  format: string
  version: number
  exportedAt: string
  checksum: McpPackageChecksum
  mcpServers: Record<string, McpExportEntry>
  [REDACTED_KEYS_NOTE]?: string[]
}

/** 组装导出文件：标准 mcpServers 在前，PocketAI 扩展键只在不空时写（标准客户端忽略未知键） */
export function buildMcpPackageFile(
  mcpServers: Record<string, McpExportEntry>,
  redactedEntries: string[],
  exportedAt: string = new Date().toISOString()
): McpPackageFile {
  const file: McpPackageFile = {
    format: MCP_PACKAGE_FORMAT,
    version: MCP_PACKAGE_VERSION,
    exportedAt,
    checksum: computeMcpChecksum(mcpServers),
    mcpServers
  }
  if (redactedEntries.length > 0) file[REDACTED_KEYS_NOTE] = redactedEntries
  return file
}

/** 校验结果：absent＝本来就没有校验和（Claude Desktop 原生文件），放行但要说出来 */
export type McpPackageVerification =
  | { state: 'absent' }
  | { state: 'ok'; checksum: McpPackageChecksum }
  | { state: 'mismatch'; expected: string; actual: string }
  | { state: 'unsupported'; reason: string }

/**
 * 校验 MCP 配置包。非包格式（没有 checksum）返回 absent，交给 parseMcpServersJson 判结构；
 * 有 checksum 却不认识/对不上，一律拒绝——放过去等于把「可能被改过」当成了「没被改过」。
 */
export function verifyMcpPackage(text: string): McpPackageVerification {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { state: 'absent' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { state: 'absent' }
  const obj = parsed as Record<string, unknown>

  const rawChecksum = obj.checksum
  if (rawChecksum === undefined || rawChecksum === null) return { state: 'absent' }
  if (typeof rawChecksum !== 'object' || Array.isArray(rawChecksum)) {
    return { state: 'unsupported', reason: 'checksum 字段不是对象' }
  }
  const c = rawChecksum as Record<string, unknown>
  const algo = typeof c.algo === 'string' ? c.algo.trim().toLowerCase() : ''
  const value = typeof c.value === 'string' ? c.value.trim().toLowerCase() : ''
  if (algo !== MCP_CHECKSUM_ALGO) {
    return { state: 'unsupported', reason: `不支持的校验算法：${algo || '空'}` }
  }
  if (!/^[0-9a-f]{64}$/.test(value)) {
    return { state: 'unsupported', reason: '校验和格式不正确' }
  }

  const container =
    obj.mcpServers && typeof obj.mcpServers === 'object' && !Array.isArray(obj.mcpServers)
      ? (obj.mcpServers as Record<string, unknown>)
      : obj
  const actual = computeMcpChecksum(container)
  if (actual.value !== value) {
    return { state: 'mismatch', expected: value, actual: actual.value }
  }
  return { state: 'ok', checksum: actual }
}
