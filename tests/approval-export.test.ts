// 审批明细导出（P0-2c-3 另一半）：纯序列化层，不碰 DB / electron。
//
// 钉住：CSV 的 BOM、固定英文表头、RFC 4180 转义（逗号/引号/换行）、null 与空串的区分；
// JSON 的字段白名单（没有原始参数/工具结果）、ISO 时间、元信息与隐私说明；
// 收集循环的硬上限与 truncated 语义、筛选条件下推。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APPROVAL_CSV_HEADERS,
  APPROVAL_EXPORT_MAX_ROWS,
  buildApprovalCsv,
  buildApprovalJson,
  collectApprovalExportRows,
  csvCell,
  formatLocalDateTime,
  toExportRow,
  type ApprovalExportRow
} from '../src/main/export/approval-export'
import type { ApprovalAuditPage, ApprovalAuditQuery, ApprovalAuditRow } from '../src/shared/types'

const auditRow = (patch: Partial<ApprovalAuditRow> = {}): ApprovalAuditRow => ({
  id: 'id-1',
  conversationId: 'c-1',
  assistantId: null,
  stepIndex: 1,
  toolId: 'shell.exec',
  toolName: 'shell.exec',
  decision: 'user_approve',
  reasonCode: 'USER_APPROVE',
  scope: 'once',
  argsDigest: 'sha256:abcdef1234567890',
  argsRedacted: '{"command":"ls"}',
  actor: 'local_user',
  requestedAt: 1_700_000_000_000,
  decidedAt: 1_700_000_006_000,
  createdAt: 1_700_000_006_000,
  ...patch
})

const exportRow = (patch: Partial<ApprovalExportRow> = {}): ApprovalExportRow => ({
  ...toExportRow(auditRow()),
  ...patch
})

describe('CSV 单元格与转义', () => {
  it('逗号 / 引号 / 换行按 RFC 4180 转义，内部引号翻倍', () => {
    expect(csvCell('{"a":1,"b":2}')).toBe('"{""a"":1,""b"":2}"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('line1\r\nline2')).toBe('"line1\r\nline2"')
  })

  it('普通字符串不加引号；数字原样；null 与空串必须可区分', () => {
    expect(csvCell('shell.exec')).toBe('shell.exec')
    expect(csvCell(6)).toBe('6')
    expect(csvCell(null)).toBe('null')
    expect(csvCell('')).toBe('""')
    expect(csvCell('null')).toBe('"null"') // 真实字符串 "null" 加引号，与空值字面量可区分
  })
})

describe('CSV 文件', () => {
  it('真写到磁盘再读回：BOM 与中文/换行内容不丢', () => {
    const csv = buildApprovalCsv([exportRow({ argsRedacted: '{"note":"中文,带逗号"}' })])
    const file = path.join(os.tmpdir(), `pai-approval-export-${Date.now()}.csv`)
    fs.writeFileSync(file, csv, 'utf8')
    try {
      const bytes = fs.readFileSync(file)
      expect(bytes[0]).toBe(0xef)
      expect(bytes[1]).toBe(0xbb)
      expect(bytes[2]).toBe(0xbf)
      const text = bytes.toString('utf8')
      expect(text).toContain('"{""note"":""中文,带逗号""}"')
      expect(text).toContain('conversation_id,decision,reason_code')
    } finally {
      fs.rmSync(file, { force: true })
    }
  })

  it('带 UTF-8 BOM、固定英文表头、CRLF 行；中文与换行参数不破行', () => {
    const csv = buildApprovalCsv([
      exportRow({ argsRedacted: '{"command":"echo 你好","dir":"/tmp"}' }),
      exportRow({ conversationId: 'c-2', reasonCode: null, argsDigest: null, argsRedacted: '第一行\n第二行' })
    ])
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n')
    expect(lines[0]).toBe(APPROVAL_CSV_HEADERS.join(','))
    expect(csv).toContain('""command"":""echo 你好""')
    // 第二行的参数摘要含换行，整格被引号包住后，物理行会比记录数多——这里只断言 null/空值语义与转义结果
    expect(csv).toContain(',null,')
    expect(csv).toContain('"第一行\n第二行"')
    expect(csv.endsWith('\r\n')).toBe(true)
  })

  it('时间列用本地时间 YYYY-MM-DD HH:mm:ss，等待秒数由两列算出差值', () => {
    const row = exportRow({ requestedAt: 1_700_000_000_000, decidedAt: 1_700_000_006_000 })
    expect(row.waitedSeconds).toBe(6)
    expect(formatLocalDateTime(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    const csv = buildApprovalCsv([row])
    expect(csv).toContain(',6,')
  })
})

describe('JSON 文件', () => {
  it('字段白名单：没有原始参数、没有工具结果，指纹原样导出', () => {
    const json = buildApprovalJson([exportRow()], {
      exportedAt: '2026-11-06T00:00:00.000Z',
      filters: { conversationId: 'c-1', decision: 'user_approve', from: 1, to: 2 },
      maxRows: APPROVAL_EXPORT_MAX_ROWS,
      exportedRows: 1,
      truncated: false
    })
    const parsed = JSON.parse(json) as {
      format: string
      filters: Record<string, unknown>
      max_rows: number
      exported_rows: number
      truncated: boolean
      privacy_note: string
      rows: Array<Record<string, unknown>>
    }
    expect(parsed.format).toBe('json')
    expect(parsed.filters).toEqual({ conversationId: 'c-1', decision: 'user_approve', from: 1, to: 2 })
    expect(parsed.max_rows).toBe(APPROVAL_EXPORT_MAX_ROWS)
    expect(parsed.exported_rows).toBe(1)
    expect(parsed.truncated).toBe(false)
    expect(parsed.privacy_note).toContain('args_digest is a one-way fingerprint')
    expect(parsed.privacy_note).toContain('at most 180 days or 100,000 rows')

    const keys = Object.keys(parsed.rows[0]!)
    expect(keys).toEqual([
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
    ])
    for (const forbidden of ['"tool_result"', '"raw_arguments"', '"raw_args"']) {
      expect(json).not.toContain(forbidden)
    }
    expect(keys).not.toContain('tool_result')
    expect(keys).not.toContain('raw_arguments')
    expect(parsed.rows[0]!.requested_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/)
    expect(parsed.rows[0]!.args_digest).toBe('sha256:abcdef1234567890')
    expect(parsed.rows[0]!.args_redacted).toBe('{"command":"ls"}')
  })

  it('null 保持 JSON null，不写成 0 或空串', () => {
    const json = buildApprovalJson([exportRow({ reasonCode: null, argsDigest: null, argsRedacted: null })], {
      exportedAt: '2026-11-06T00:00:00.000Z',
      filters: {},
      maxRows: APPROVAL_EXPORT_MAX_ROWS,
      exportedRows: 1,
      truncated: false
    })
    const row = (JSON.parse(json) as { rows: Array<Record<string, unknown>> }).rows[0]!
    expect(row.reason_code).toBeNull()
    expect(row.args_digest).toBeNull()
    expect(row.args_redacted).toBeNull()
  })
})

describe('收集循环：硬上限与筛选', () => {
  const pages = (rows: ApprovalAuditRow[]): ((q: ApprovalAuditQuery) => ApprovalAuditPage) => (q) => {
    const slice = rows.slice(q.offset, q.offset + q.limit)
    return { rows: slice, hasMore: q.offset + slice.length < rows.length }
  }

  it('超过硬上限时只收前 N 行并标记 truncated', () => {
    const rows = Array.from({ length: 7 }, (_, i) => auditRow({ id: `id-${i}` }))
    const { rows: got, truncated } = collectApprovalExportRows(pages(rows), {}, 3)
    expect(got).toHaveLength(3)
    expect(truncated).toBe(true)
    expect(got.map((r) => r.id)).toEqual(['id-0', 'id-1', 'id-2'])
  })

  it('恰好等于上限且没有更多 ⇒ 不算截断', () => {
    const rows = Array.from({ length: 3 }, (_, i) => auditRow({ id: `id-${i}` }))
    const { rows: got, truncated } = collectApprovalExportRows(pages(rows), {}, 3)
    expect(got).toHaveLength(3)
    expect(truncated).toBe(false)
  })

  it('筛选条件原样下推给分页查询', () => {
    const rows = [auditRow()]
    const { rows: got } = collectApprovalExportRows(pages(rows), {
      conversationId: 'c-9',
      decision: 'user_deny',
      from: 100,
      to: 200
    })
    // 直接检查 stub 收到的查询：再包一层记录器
    const seen: ApprovalAuditQuery[] = []
    collectApprovalExportRows((q) => {
      seen.push(q)
      return { rows: [], hasMore: false }
    }, { conversationId: 'c-9', decision: 'user_deny', from: 100, to: 200 })
    const first = seen[0]!
    expect(first.conversationId).toBe('c-9')
    expect(first.decision).toBe('user_deny')
    expect(first.from).toBe(100)
    expect(first.to).toBe(200)
    expect(first.offset).toBe(0)
    expect(first.limit).toBeGreaterThan(0)
    expect(first.limit).toBeLessThanOrEqual(APPROVAL_EXPORT_MAX_ROWS)
    expect(got).toHaveLength(1)
  })
})
