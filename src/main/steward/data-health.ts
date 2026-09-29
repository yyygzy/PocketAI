// 数据健康度聚合（Settings「数据健康」面板）
//
// 与平台管家（diagnose.ts）分工：管家偏安全姿态与故障诊断（需手动触发、含评分），
// 这里偏数据资产的日常可读快照——体量明细、知识库索引状态、备份与维护任务运行情况。
// 全部只读探测，逐项容错：单项失败不阻断整份报告。
//
// 纯函数（classifyDataEntry / aggregateDataSizes / groupDocStatus / topErrorDocs）
// 单独导出供 tests/data-health.test.ts 直测。

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DataHealthReport, KbDocStatus, KbDocument } from '../../shared/types'
import { DATA_DIR } from '../portable'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbRepo } from '../db/repositories/kb.repo'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { loadWebDAVConfig } from '../backup/backup-service'
import { getBackupSchedule } from '../backup/backup-scheduler'
import { errMsg } from '../error'

// ─── 纯函数：数据目录体积分类聚合 ────────────────────────────────

export type DataBucket = 'db' | 'vectors' | 'attachments' | 'extensions' | 'logs' | 'other'

/**
 * 按 DATA_DIR 相对路径（统一 / 分隔）归类体积桶。
 * 根级 app.db / app.db-wal → db；vectors.db / vectors.db-wal → vectors；
 * 一级子目录 attachments/extensions/logs 下全部归对应桶；其余 → other。
 */
export function classifyDataEntry(rel: string): DataBucket {
  const norm = rel.replaceAll('\\', '/')
  if (norm === 'app.db' || norm === 'app.db-wal') return 'db'
  if (norm === 'vectors.db' || norm === 'vectors.db-wal') return 'vectors'
  const top = norm.split('/')[0]
  if (top === 'attachments' || top === 'extensions' || top === 'logs') return top
  return 'other'
}

export interface DataSizeEntry {
  /** 相对 DATA_DIR 的路径（/ 分隔） */
  rel: string
  bytes: number
}

/** 体积条目按桶聚合 → DataHealthReport.sizes */
export function aggregateDataSizes(entries: DataSizeEntry[]): DataHealthReport['sizes'] {
  const buckets: Record<DataBucket, number> = {
    db: 0, vectors: 0, attachments: 0, extensions: 0, logs: 0, other: 0
  }
  for (const e of entries) buckets[classifyDataEntry(e.rel)] += e.bytes
  return {
    dataDirBytes: entries.reduce((s, e) => s + e.bytes, 0),
    dbBytes: buckets.db,
    vectorDbBytes: buckets.vectors,
    attachmentsBytes: buckets.attachments,
    extensionsBytes: buckets.extensions,
    logsBytes: buckets.logs,
    otherBytes: buckets.other
  }
}

// ─── 纯函数：知识库文档状态 ──────────────────────────────────────

export const KB_STATUSES: KbDocStatus[] = ['pending', 'parsing', 'indexing', 'ready', 'error']

/** 全部文档按状态计数（五状态恒齐全，缺省补 0） */
export function groupDocStatus(docs: KbDocument[]): Record<KbDocStatus, number> {
  const out = { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 }
  for (const d of docs) {
    if (d.status in out) out[d.status]++
  }
  return out
}

export interface DataHealthErrorDoc {
  id: string
  kbName: string
  title: string
  error: string | null
  createdAt: number
}

/** 失败文档清单：创建时间倒序取前 limit 条，kbName 由调用方注入（避免纯函数依赖 DB） */
export function topErrorDocs(
  docs: KbDocument[],
  kbNameOf: (kbId: string) => string,
  limit = 10
): DataHealthErrorDoc[] {
  return docs
    .filter((d) => d.status === 'error')
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((d) => ({ id: d.id, kbName: kbNameOf(d.kbId), title: d.title || d.source, error: d.error, createdAt: d.createdAt }))
}

// ─── fs 探测：数据目录递归体积 ──────────────────────────────────

/** 递归收集目录下全部文件的相对路径与体积；单项 stat 失败忽略 */
function walkDataDir(dir: string, base: string, out: DataSizeEntry[]): void {
  let items: import('node:fs').Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在/不可读 → 该桶按 0 处理
  }
  for (const it of items) {
    const full = path.join(dir, it.name)
    if (it.isDirectory()) {
      walkDataDir(full, base, out)
    } else if (it.isFile()) {
      try {
        out.push({
          rel: path.relative(base, full).replaceAll('\\', '/'),
          bytes: statSync(full).size
        })
      } catch { /* 竞态删除/权限 → 跳过该文件 */ }
    }
  }
}

// ─── 报告聚合 ────────────────────────────────────────────────────

function readLastRun(key: string): number | null {
  try {
    const v = Number(appConfigRepo.get(key))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

/** 聚合数据健康度报告（DB 未解锁时 kb/backup/tasks 探测会抛错，由 safeHandle 兜底） */
export function getDataHealthReport(): DataHealthReport {
  // 1. 体量：一次全目录递归，按桶分类
  const entries: DataSizeEntry[] = []
  walkDataDir(DATA_DIR, DATA_DIR, entries)
  const sizes = aggregateDataSizes(entries)

  // 2. 知识库索引状态
  const docs = kbDocRepo.listAll()
  const kbNameById = new Map(kbRepo.list().map((k) => [k.id, k.name]))
  const kb = {
    total: docs.length,
    byStatus: groupDocStatus(docs),
    errorDocs: topErrorDocs(docs, (kbId) => kbNameById.get(kbId) ?? '(未知库)')
  }

  // 3. 备份状态（未配置 WebDAV 时 schedule 仍可读，lastRunAt 为 null）
  const configured = !!loadWebDAVConfig()
  let backup: DataHealthReport['backup'] = {
    configured, enabled: false, intervalHours: 24,
    lastRunAt: null, lastOkAt: null, lastError: null
  }
  try {
    const s = getBackupSchedule()
    backup = {
      configured,
      enabled: s.enabled,
      intervalHours: s.intervalHours,
      lastRunAt: s.lastRunAt,
      lastOkAt: s.lastResult?.ok ? s.lastResult.at : null,
      lastError: s.lastResult && !s.lastResult.ok ? s.lastResult.error ?? '备份失败' : null
    }
  } catch (e) {
    backup.lastError = errMsg(e, '备份状态读取失败')
  }

  // 4. 内置维护任务上次运行时间
  const tasks = {
    kbHealthCheckLastRunAt: readLastRun('task.kb_health_check.last_run_at'),
    backupVerifyLastRunAt: readLastRun('task.backup_verify.last_run_at')
  }

  return { sizes, kb, backup, tasks }
}
