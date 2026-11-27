// 导入结果审计（import_result_audits，v82）
//
// 与 v64 的 skill_import_audits 分工：v64 记「扫描结论分级」，这张表记「导入动作结果」。
// 只存来源、校验状态、计数、错误码；不存包正文、findings examples、env/headers 的值。
// 写入失败不抛（fail-open）：审计是旁路，不能因为它写不进去就让一次已经成功的导入失败。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { createLogger } from '../../logger'
import {
  setImportResultAuditWriter,
  type ImportChecksumState,
  type ImportResultAuditInput,
  type ImportResultAuditRecord,
  type ImportResultKind,
  type ImportResultSource
} from '../import-result-audit'

const log = createLogger('import-result-audits')

export type {
  ImportChecksumState,
  ImportResultAuditInput,
  ImportResultAuditRecord,
  ImportResultKind,
  ImportResultSource
} from '../import-result-audit'

interface ImportResultAuditDbRow {
  id: string
  kind: ImportResultKind
  source: ImportResultSource
  source_detail: string
  checksum: ImportChecksumState
  ok: number
  error_code: string
  imported_count: number
  failed_count: number
  cleared_key_count: number
  created_at: number
}

const clamp = (value: string, max: number): string => (value.length <= max ? value : value.slice(0, max))
const nonNegativeInt = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, Math.floor(value as number)) : 0

function rowToRecord(row: ImportResultAuditDbRow): ImportResultAuditRecord {
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    sourceDetail: row.source_detail,
    checksum: row.checksum,
    ok: row.ok === 1,
    errorCode: row.error_code,
    importedCount: row.imported_count,
    failedCount: row.failed_count,
    clearedKeyCount: row.cleared_key_count,
    createdAt: row.created_at
  }
}

let writeFailures = 0

/** 审计写失败次数（诊断用；本轮不接界面） */
export function getImportResultAuditFailureCount(): number {
  return writeFailures
}

export const importResultAuditRepo = {
  insert(input: ImportResultAuditInput): boolean {
    try {
      if (!dbService.isOpen()) return false
      const record: ImportResultAuditRecord = {
        id: randomUUID(),
        kind: input.kind,
        source: input.source,
        sourceDetail: clamp(String(input.sourceDetail ?? ''), 1000),
        checksum: input.checksum ?? '',
        ok: input.ok,
        errorCode: clamp(String(input.errorCode ?? ''), 200),
        importedCount: nonNegativeInt(input.importedCount),
        failedCount: nonNegativeInt(input.failedCount),
        clearedKeyCount: nonNegativeInt(input.clearedKeyCount),
        createdAt: Date.now()
      }
      dbService
        .getHandle()
        .prepare(
          `INSERT INTO import_result_audits
             (id, kind, source, source_detail, checksum, ok, error_code,
              imported_count, failed_count, cleared_key_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.kind,
          record.source,
          record.sourceDetail,
          record.checksum,
          record.ok ? 1 : 0,
          record.errorCode,
          record.importedCount,
          record.failedCount,
          record.clearedKeyCount,
          record.createdAt
        )
      return true
    } catch (e) {
      writeFailures += 1
      log.warn('导入结果审计写入失败（不影响导入结果）:', e instanceof Error ? e.message : String(e))
      return false
    }
  },

  listByKind(kind: ImportResultKind): ImportResultAuditRecord[] {
    const rows = dbService
      .getHandle()
      .prepare(
        'SELECT * FROM import_result_audits WHERE kind=? ORDER BY created_at DESC, id DESC LIMIT 200'
      )
      .all(kind) as ImportResultAuditDbRow[]
    return rows.map(rowToRecord)
  }
}

// 启动加载本仓储时注入；纯逻辑测试不 import 本文件，写入口保持 no-op。
setImportResultAuditWriter(importResultAuditRepo)
