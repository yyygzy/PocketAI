// 审批明细导出（P0-2c-3 另一半）：把「当前筛选结果」落成 JSON / CSV。
//
// 口径（与明细屏一致，且在导出侧更硬）：
// - 只导出白名单字段：`args_redacted` 是唯一参数来源，绝不导出原始参数或工具结果；
// - 独立硬上限 `APPROVAL_EXPORT_MAX_ROWS`，超出时如实回报 truncated，绝不静默截断；
// - CSV 带 UTF-8 BOM（Excel 直接双击打开中文才不会乱码），字段按 RFC 4180 转义（逗号/引号/换行）；
// - `null` 在 CSV 里写成字面量 `null`（不写 0 或空串，避免"没有值"被读成"值为空"）；空字符串写成 `""`；
// - 时间：JSON 用 ISO 8601（UTC，机读无歧义），CSV 用本地时间 `YYYY-MM-DD HH:mm:ss`（表格里直观）。
import type {
  ApprovalAuditPage,
  ApprovalAuditQuery,
  ApprovalAuditRow,
  ApprovalDecision,
  ApprovalScope
} from '../../shared/types'

/** 收集时的每页行数（与 IPC 列表的单页上限 100 一致；repo 侧还会再 clamp 一次） */
const EXPORT_PAGE_SIZE = 100

/**
 * 单次导出硬上限（行）。
 * 理由：导出是本地写文件、不联网，但仍不能让 10 万行账本一次进内存；
 * 2000 行 ≈ 20 个查询页，JSON 通常数百 KB 到数 MB，足够覆盖"缩小筛选后一次导完"的常见场景，
 * 又远低于全表，超出时界面明确提示只导出了前 N 行。
 */
export const APPROVAL_EXPORT_MAX_ROWS = 2000

/** 导出用的筛选条件（与明细屏的会话/决定/时间范围同口径，不含分页） */
export interface ApprovalExportFilters {
  conversationId?: string
  decision?: ApprovalDecision
  from?: number
  to?: number
}

/** 导出行的白名单形态：没有任何原始参数/工具结果字段 */
export interface ApprovalExportRow {
  conversationId: string
  decision: ApprovalDecision
  reasonCode: string | null
  scope: ApprovalScope
  actor: string
  toolId: string
  toolName: string
  requestedAt: number
  decidedAt: number
  waitedSeconds: number
  argsDigest: string | null
  argsRedacted: string | null
}

/** 从明细行按白名单重建对象（刻意不 spread：将来表里多出字段也不会漏进导出） */
export function toExportRow(row: ApprovalAuditRow): ApprovalExportRow {
  return {
    conversationId: row.conversationId,
    decision: row.decision,
    reasonCode: row.reasonCode,
    scope: row.scope,
    actor: row.actor,
    toolId: row.toolId,
    toolName: row.toolName,
    requestedAt: row.requestedAt,
    decidedAt: row.decidedAt,
    waitedSeconds: Math.max(0, Math.round((row.decidedAt - row.requestedAt) / 1000)),
    argsDigest: row.argsDigest,
    argsRedacted: row.argsRedacted
  }
}

/**
 * 按 100 行/页收集导出结果，直到没有下一页或触到硬上限。
 * 返回 `truncated=还有行没导出`（刚好等于上限且没有更多时为 false）。
 */
export function collectApprovalExportRows(
  pageFn: (query: ApprovalAuditQuery) => ApprovalAuditPage,
  filters: ApprovalExportFilters,
  maxRows: number = APPROVAL_EXPORT_MAX_ROWS
): { rows: ApprovalAuditRow[]; truncated: boolean } {
  const rows: ApprovalAuditRow[] = []
  let offset = 0
  for (;;) {
    const remaining = maxRows - rows.length
    if (remaining <= 0) break
    const page = pageFn({ offset, limit: Math.min(EXPORT_PAGE_SIZE, remaining), ...filters })
    rows.push(...page.rows)
    offset += page.rows.length
    if (!page.hasMore) return { rows, truncated: false }
    if (page.rows.length === 0) return { rows, truncated: false }
    if (rows.length >= maxRows) return { rows, truncated: true }
  }
  return { rows, truncated: false }
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（CSV 用；时区与用户系统一致） */
export function formatLocalDateTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * CSV 单元格：RFC 4180 转义。
 * `null` → 字面量 `null`（不伪装成 0/空串）；空字符串 → `""`；含逗号/引号/换行的加引号并把内部引号翻倍。
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return 'null'
  if (typeof value === 'number') return String(value)
  if (value === '') return '""'
  // 真实字符串 "null" 加引号，和空值字面量 null 区分开
  if (value === 'null') return '"null"'
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

/** 固定英文字段名：表头是数据契约，不随界面语言变化，脚本才能稳定解析 */
export const APPROVAL_CSV_HEADERS = [
  'conversation_id',
  'decision',
  'reason_code',
  'scope',
  'actor',
  'tool_id',
  'tool_name',
  'requested_at',
  'decided_at',
  'waited_seconds',
  'args_digest',
  'args_redacted'
] as const

/** CSV 文本：BOM + 固定表头 + CRLF 行（SQLite/Excel 都吃的 RFC 4180 形态） */
export function buildApprovalCsv(rows: ApprovalExportRow[]): string {
  const lines = [APPROVAL_CSV_HEADERS.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.conversationId,
        r.decision,
        r.reasonCode,
        r.scope,
        r.actor,
        r.toolId,
        r.toolName,
        formatLocalDateTime(r.requestedAt),
        formatLocalDateTime(r.decidedAt),
        r.waitedSeconds,
        r.argsDigest,
        r.argsRedacted
      ]
        .map(csvCell)
        .join(',')
    )
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n'
}

/** JSON 里的隐私说明：只陈述事实，不出现"完整审计/永久保留/已加密"这类超出事实的说法 */
const PRIVACY_NOTE =
  'Only args_redacted is exported; raw arguments and tool results are never exported. ' +
  'args_digest is a one-way fingerprint: it can only prove that two decisions concerned the same arguments, ' +
  'and cannot reconstruct them. Deleting a conversation deletes its approval records; ' +
  'records are kept for at most 180 days or 100,000 rows.'

export interface ApprovalExportJsonMeta {
  exportedAt: string
  filters: ApprovalExportFilters
  maxRows: number
  exportedRows: number
  truncated: boolean
}

/** JSON 行：与 CSV 同一套 snake_case 字段；时间用 ISO 8601（UTC） */
function jsonRow(r: ApprovalExportRow): Record<string, string | number | null> {
  return {
    conversation_id: r.conversationId,
    decision: r.decision,
    reason_code: r.reasonCode,
    scope: r.scope,
    actor: r.actor,
    tool_id: r.toolId,
    tool_name: r.toolName,
    requested_at: new Date(r.requestedAt).toISOString(),
    decided_at: new Date(r.decidedAt).toISOString(),
    waited_seconds: r.waitedSeconds,
    args_digest: r.argsDigest,
    args_redacted: r.argsRedacted
  }
}

/** JSON 文本：元信息（筛选/上限/是否截断/隐私说明）+ 行数组 */
export function buildApprovalJson(rows: ApprovalExportRow[], meta: ApprovalExportJsonMeta): string {
  return (
    JSON.stringify(
      {
        exported_at: meta.exportedAt,
        format: 'json',
        filters: meta.filters,
        max_rows: meta.maxRows,
        exported_rows: meta.exportedRows,
        truncated: meta.truncated,
        privacy_note: PRIVACY_NOTE,
        rows: rows.map(jsonRow)
      },
      null,
      2
    ) + '\n'
  )
}
