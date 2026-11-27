// MCP 配置包导入：校验和 → 解析 → 逐条落库（P2-3）
//
// 三条口径：
//  ① 完整性先于解析：校验和不一致/算法不认识就整包拒绝，不落任何一条；
//  ② 同名不覆盖：已占用的名字加 ` (2)` 后缀并存，绝不静默覆盖已有配置；
//  ③ 密钥一律清空：导入包里的凭据字段置空并逐项回报，界面提示「需重新填写」。
// 单条失败不阻断其他条目（与 parseMcpServersJson 的既有语义一致）。
import { errMsg } from '../error'
import { mcpServerRepo } from '../db/repositories/mcp-server.repo'
import {
  recordImportResult,
  type ImportChecksumState,
  type ImportResultSource
} from '../db/import-result-audit'
import {
  parseMcpServersJson,
  stripMcpSecrets,
  uniqueMcpServerName
} from '../../shared/mcp-import'
import { verifyMcpPackage } from './mcp-package'
import { assertCommandLineSafe } from './win-shim'

export interface McpImportOutcome {
  ok: boolean
  /** verified＝包内校验和一致；absent＝没有校验和（Claude Desktop 原生文件），放行但未校验完整性 */
  checksum?: 'verified' | 'absent'
  imported?: Array<{ key: string; name: string }>
  failed?: Array<{ key: string; error: string }>
  /** 被清空的凭据键，形如 `fs>API_KEY` */
  clearedKeys?: string[]
  /** 解析期非阻断警告（如 x-pocketai-python-packages 类型不对被忽略），逐条回传给界面 */
  warnings?: string[]
  error?: string
}

/** 结果审计是旁路：只记来源/校验状态/计数/错误码，绝不记密钥值或包正文 */
function auditImport(
  source: ImportResultSource,
  input: {
    checksum: ImportChecksumState
    ok: boolean
    errorCode?: string
    importedCount?: number
    failedCount?: number
    clearedKeyCount?: number
  }
): void {
  recordImportResult({ kind: 'mcp', source, ...input })
}

/**
 * 从文本导入整包 MCP 配置。文件读取/大小闸在 IPC 层，这里只管内容与落库，便于直接测。
 * 返回 ok=true 也可能 imported 为空（全部条目结构非法）：那不是包的问题，逐条原因在 failed 里。
 *
 * verifyChecksum=false 只给「粘贴导入」用：没有文件包就没有包级校验和可言，
 * 此时一律按 absent 处理并在界面照实说未校验——不能把「没验」说成「验过了」。
 */
export function importMcpPackageText(
  raw: string,
  opts: { verifyChecksum?: boolean } = {}
): McpImportOutcome {
  const source: ImportResultSource = opts.verifyChecksum === false ? 'paste' : 'file'
  const verification =
    opts.verifyChecksum === false ? ({ state: 'absent' } as const) : verifyMcpPackage(raw)
  if (verification.state === 'mismatch') {
    auditImport(source, { checksum: 'mismatch', ok: false, errorCode: 'CHECKSUM_MISMATCH' })
    return { ok: false, error: 'CHECKSUM_MISMATCH' }
  }
  if (verification.state === 'unsupported') {
    auditImport(source, { checksum: 'unsupported', ok: false, errorCode: 'CHECKSUM_UNSUPPORTED' })
    return { ok: false, error: 'CHECKSUM_UNSUPPORTED' }
  }

  const parsed = parseMcpServersJson(raw)
  // 整体结构非法时 parser 给的是用户可读原文（JSON 解析失败 / 缺少 mcpServers），原样上抛
  if (parsed.error) {
    auditImport(source, { checksum: verification.state === 'ok' ? 'verified' : 'absent', ok: false, errorCode: 'PARSE_FAILED' })
    return { ok: false, error: parsed.error }
  }

  const taken = new Set(mcpServerRepo.list().map((r) => r.name))
  const imported: Array<{ key: string; name: string }> = []
  const failed: Array<{ key: string; error: string }> = []
  const clearedKeys: string[] = []
  const warnings: string[] = []

  for (const item of parsed.items) {
    if (!item.draft) {
      failed.push({ key: item.key, error: item.error ?? '条目不可用' })
      continue
    }
    const d = item.draft
    // M7：cmd.exe 元字符在导入时即拒，避免恶意 command 落库等待 Windows 启动时注入
    if (d.transport !== 'http' && d.command) {
      try {
        assertCommandLineSafe(d.command, d.args ?? [])
      } catch (e) {
        failed.push({ key: item.key, error: errMsg(e) })
        continue
      }
    }
    const stripped = stripMcpSecrets(d.name, d.env, d.headers)
    const name = uniqueMcpServerName(d.name, taken)
    try {
      const rec = mcpServerRepo.save({
        name,
        transport: d.transport,
        runtime: d.runtime,
        command: d.command,
        args: d.args,
        env: stripped.env,
        url: d.url,
        headers: stripped.headers,
        pythonPackages: d.pythonPackages,
        // 导入不能让配置跳过 SEC-5 的默认：只读工具免确认必须由用户在该 Server 上显式打开
        trustReadOnly: false
      })
      taken.add(rec.name)
      imported.push({ key: item.key, name: rec.name })
      clearedKeys.push(...stripped.clearedKeys)
      if (item.warning) warnings.push(`${item.key}: ${item.warning}`)
    } catch (e) {
      failed.push({ key: item.key, error: errMsg(e) })
    }
  }

  const checksum: ImportChecksumState = verification.state === 'ok' ? 'verified' : 'absent'
  auditImport(source, {
    checksum,
    ok: true,
    importedCount: imported.length,
    failedCount: failed.length,
    clearedKeyCount: clearedKeys.length
  })
  return {
    ok: true,
    checksum,
    imported,
    failed,
    clearedKeys,
    warnings
  }
}
