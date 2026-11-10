// 技能导入审计（skill_import_audits，v64）
//
// 只回答三件事：什么时候导入的、来源是哪、静态扫描是什么分级。
// 刻意不存 findings 的 examples——那些是正文片段，可能含用户密钥/令牌；审计账本不该成为第二个泄漏面。
// 写入失败不抛（fail-open）：审计是旁路，不能因为它写不进去就让一次已经成功的导入失败。
import { randomUUID } from 'node:crypto'
import { dbService } from '../database'
import { createLogger } from '../../logger'
import type { SkillScanLevel, SkillScanResult } from '../../skills/skill-scan'

const log = createLogger('skill-import-audits')

export type SkillImportSource = 'file' | 'folder' | 'url'

export interface SkillImportAuditInput {
  skillId: string
  skillName: string
  source: SkillImportSource
  /** 来源明细：URL 只留 origin+pathname，本地只留文件名（不抄整条本机路径） */
  sourceDetail: string
  scan: SkillScanResult
}

export interface SkillImportAuditRecord {
  id: string
  skillId: string
  skillName: string
  source: SkillImportSource
  sourceDetail: string
  scanLevel: SkillScanLevel
  findingCodes: string[]
  findingCount: number
  createdAt: number
}

interface SkillImportAuditDbRow {
  id: string
  skill_id: string
  skill_name: string
  source: SkillImportSource
  source_detail: string
  scan_level: SkillScanLevel
  finding_codes: string
  finding_count: number
  created_at: number
}

const clamp = (value: string, max: number): string => (value.length <= max ? value : value.slice(0, max))

function parseCodes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function rowToRecord(row: SkillImportAuditDbRow): SkillImportAuditRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    skillName: row.skill_name,
    source: row.source,
    sourceDetail: row.source_detail,
    scanLevel: row.scan_level,
    findingCodes: parseCodes(row.finding_codes),
    findingCount: row.finding_count,
    createdAt: row.created_at
  }
}

let writeFailures = 0

/** 审计写失败次数（诊断用；本轮不接界面） */
export function getSkillImportAuditFailureCount(): number {
  return writeFailures
}

export const skillImportAuditRepo = {
  /** 落一条导入审计；失败只记日志与计数，不抛（返回 false） */
  insert(input: SkillImportAuditInput): boolean {
    try {
      const record: SkillImportAuditRecord = {
        id: randomUUID(),
        skillId: String(input.skillId ?? ''),
        skillName: clamp(String(input.skillName ?? ''), 200),
        source: input.source,
        sourceDetail: clamp(String(input.sourceDetail ?? ''), 1000),
        scanLevel: input.scan.level,
        findingCodes: input.scan.findings.map((f) => f.code),
        findingCount: input.scan.findings.length,
        createdAt: Date.now()
      }
      dbService
        .getHandle()
        .prepare(
          `INSERT INTO skill_import_audits
             (id, skill_id, skill_name, source, source_detail, scan_level, finding_codes, finding_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.skillId,
          record.skillName,
          record.source,
          record.sourceDetail,
          record.scanLevel,
          JSON.stringify(record.findingCodes),
          record.findingCount,
          record.createdAt
        )
      return true
    } catch (e) {
      writeFailures += 1
      log.warn('技能导入审计写入失败（不影响导入结果）:', e instanceof Error ? e.message : String(e))
      return false
    }
  },

  /** 按技能 id 倒序取审计行（测试与后续诊断用） */
  listBySkill(skillId: string): SkillImportAuditRecord[] {
    const rows = dbService
      .getHandle()
      .prepare(
        'SELECT * FROM skill_import_audits WHERE skill_id=? ORDER BY created_at DESC, id DESC'
      )
      .all(String(skillId ?? '')) as SkillImportAuditDbRow[]
    return rows.map(rowToRecord)
  }
}
