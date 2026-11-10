// 数据健康度聚合（Settings「数据健康」面板）
//
// 与平台管家（diagnose.ts）分工：管家偏安全姿态与故障诊断（需手动触发、含评分），
// 这里偏数据资产的日常可读快照——体量明细、知识库索引状态、备份与维护任务运行情况。
// 全部只读探测，逐项容错：单项失败不阻断整份报告。
//
// 纯函数（classifyDataEntry / aggregateDataSizes / topErrorDocs）
// 单独导出供 tests/data-health.test.ts 直测。

import type { DataHealthReport, KbDocument, KbIntegrityReport } from '../../shared/types'
import { isBrowserProfilePath } from '../../shared/data-dirs'
import { walkEntries, type WalkFileEntry } from '../fs/dir-walk'
import { DATA_DIR } from '../portable'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbRepo } from '../db/repositories/kb.repo'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { approvalEventRepo, getApprovalAuditFailureCount } from '../db/repositories/approval-event.repo'
import { readWebDAVConfig } from '../backup/backup-service'
import { getBackupSchedule } from '../backup/backup-scheduler'
import { errMsg } from '../error'
import { getKbIntegrityReport, getVectorIndexStats } from '../knowledge/kb-health'
import { OFFLOAD_DIR_NAME } from '../agent/tool-output-offload'
import { SNAPSHOT_DIR_NAME } from '../agent/file-snapshots'

// ─── 纯函数：数据目录体积分类聚合 ────────────────────────────────

export type DataBucket =
  | 'db'
  | 'attachments'
  | 'extensions'
  | 'logs'
  | 'browserCache'
  | 'coldOffload'
  | 'coldSnapshots'
  | 'other'

/**
 * 按 DATA_DIR 相对路径（统一 / 分隔）归类体积桶。
 * 根级 app.db / app.db-wal → db；一级子目录 attachments/extensions/logs 下全部归对应桶；其余 → other。
 * 没有「向量库」桶：向量索引不是独立文件（`kb_vec_map` + `kb_vec_<dim>` 都在 app.db 里），
 * 以前按 vectors.db 分桶，那张卡片因此恒为空——现改由 kb.vectorIndex 报真实条数与维度。
 *
 * `browserCache` 是 V4-Iter-177 加的：`userdata/` + `session/` 是 Electron 自己的 Chromium
 * 档案树（Cache/Code Cache/GPUCache/blob_storage…），本机实测 21,103 个文件 / 801 MB，
 * 而真正属于用户的数据资产只有几 MB。**它不进合计**（面板单独一格如实显示）。
 */
export function classifyDataEntry(rel: string): DataBucket {
  const norm = rel.replaceAll('\\', '/')
  if (norm === 'app.db' || norm === 'app.db-wal') return 'db'
  if (isBrowserProfilePath(norm)) return 'browserCache'
  const top = norm.split('/')[0]
  if (top === 'attachments' || top === 'extensions' || top === 'logs') return top
  // P0-5 第三批：冷数据从「其他」里摘出来单列（体积与条数都要看得见）；
  // 目录名取自两个存储模块，避免面板口径与实际落点漂移。
  if (top === OFFLOAD_DIR_NAME) return 'coldOffload'
  if (top === SNAPSHOT_DIR_NAME) return 'coldSnapshots'
  return 'other'
}

export interface DataSizeEntry {
  /** 相对 base 的路径（/ 分隔） */
  rel: string
  bytes: number
}

/** 体积条目按桶聚合 → DataHealthReport.sizes（合计只算用户数据，浏览器缓存单列）
 *
 * 冷数据（卸载文件 / 写入快照）单独成桶，但仍计入 `userDataBytes`——它们确实占用户数据目录的盘，
 * 只是以前混在「其他」里看不见。条数只数**正式文件**（卸载 `.txt` / 快照 `.json`），
 * 半写的 `.part` 算字节但不计条数。
 */
export function aggregateDataSizes(entries: DataSizeEntry[]): DataHealthReport['sizes'] {
  const buckets: Record<DataBucket, number> = {
    db: 0, attachments: 0, extensions: 0, logs: 0, browserCache: 0,
    coldOffload: 0, coldSnapshots: 0, other: 0
  }
  let cacheFiles = 0
  let coldOffloadFiles = 0
  let coldSnapshotFiles = 0
  for (const e of entries) {
    const b = classifyDataEntry(e.rel)
    buckets[b] += e.bytes
    if (b === 'browserCache') cacheFiles++
    const norm = e.rel.replaceAll('\\', '/')
    if (b === 'coldOffload' && norm.endsWith('.txt')) coldOffloadFiles++
    if (b === 'coldSnapshots' && norm.endsWith('.json')) coldSnapshotFiles++
  }
  return {
    userDataBytes:
      buckets.db + buckets.attachments + buckets.extensions + buckets.logs +
      buckets.coldOffload + buckets.coldSnapshots + buckets.other,
    dbBytes: buckets.db,
    attachmentsBytes: buckets.attachments,
    extensionsBytes: buckets.extensions,
    logsBytes: buckets.logs,
    otherBytes: buckets.other,
    coldOffloadBytes: buckets.coldOffload,
    coldOffloadFiles,
    coldSnapshotBytes: buckets.coldSnapshots,
    coldSnapshotFiles,
    browserCacheBytes: buckets.browserCache,
    browserCacheFiles: cacheFiles
  }
}

// ─── 纯函数：知识库失败文档 ──────────────────────────────────────

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

/** 用户数据明细（不含浏览器档案树）——每次都现走，附件/日志这类会变的量必须新鲜 */
export function collectUserDataEntries(): DataSizeEntry[] {
  const walked: WalkFileEntry[] = []
  walkEntries(DATA_DIR, DATA_DIR, walked, 'skipProfile')
  return walked.map((e) => ({ rel: e.rel, bytes: e.bytes }))
}

export interface BrowserCacheStats {
  bytes: number
  files: number
}

/**
 * 浏览器档案树（userdata/ + session/）的体积与文件数：**同一进程内只数一遍**。
 * 本机实测 21,103 个文件 / 801 MB，递归 stat 约 569ms（冷 692ms），而它不是用户的数据资产，
 * 变动也不该被当成"面板里那个数变了" ⇒ 只在按「刷新」时重算（不新增持久化，重启后重新数一遍）。
 */
let browserCacheMemo: BrowserCacheStats | null = null

/**
 * 两棵档案树各自的体积与文件数（现走、不走 memo）。
 * 存在的唯一理由是对账「清完 HTTP 缓存到底哪棵掉了」——`getBrowserCacheStats` 给的是合计，
 * 而 userdata/ 与 session/ 分别归谁这件事我们没从 Electron 文档里查到定论（台账 V4-Iter-182 列的未证问题之一），
 * 所以不写推测，用一次真实清理的量去回答。
 */
export function browserCacheTreeBreakdown(): Array<{ tree: string; bytes: number; files: number }> {
  const entries: WalkFileEntry[] = []
  walkEntries(DATA_DIR, DATA_DIR, entries, 'onlyProfile')
  const byTree = new Map<string, { bytes: number; files: number }>()
  for (const e of entries) {
    const tree = e.rel.split('/')[0] ?? e.rel
    const cur = byTree.get(tree) ?? { bytes: 0, files: 0 }
    cur.bytes += e.bytes
    cur.files += 1
    byTree.set(tree, cur)
  }
  return [...byTree.entries()].map(([tree, v]) => ({ tree, ...v })).sort((a, b) => a.tree.localeCompare(b.tree))
}

export function getBrowserCacheStats(refresh: boolean): BrowserCacheStats {
  if (refresh || !browserCacheMemo) {
    const out: WalkFileEntry[] = []
    walkEntries(DATA_DIR, DATA_DIR, out, 'onlyProfile')
    browserCacheMemo = { bytes: out.reduce((s, e) => s + e.bytes, 0), files: out.length }
  }
  return browserCacheMemo
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

function readLastOk(key: string): boolean | null {
  try {
    const raw = appConfigRepo.get(key)
    return raw === '1' ? true : raw === '0' ? false : null
  } catch {
    return null
  }
}

/** 聚合数据健康度报告（DB 未解锁时 kb/backup/tasks 探测会抛错，由 safeHandle 兜底）
 *  @param opts.refresh 面板上那颗「刷新」按钮：只影响浏览器缓存那一格是否重算（V4-Iter-177） */
export function getDataHealthReport(opts: { refresh?: boolean } = {}): DataHealthReport {
  // 1. 体量：用户数据每次现走；浏览器档案树按进程缓存（21,103 个文件实测约 569ms）
  const agg = aggregateDataSizes(collectUserDataEntries())
  const cache = getBrowserCacheStats(!!opts.refresh)
  const sizes: DataHealthReport['sizes'] = {
    ...agg,
    browserCacheBytes: cache.bytes,
    browserCacheFiles: cache.files
  }

  // 1b. 审批审计账本（approval_events）：行数 + 本次进程内写失败次数（fail-open 的可观测面）。
  const approvals = {
    rows: approvalEventRepo.count(),
    writeFailures: getApprovalAuditFailureCount()
  }

  // 2. 知识库索引状态 + 完整性探测（探测整体容错：失败按全空处理，不阻断报告）
  const docs = kbDocRepo.listAll()
  const kbNameById = new Map(kbRepo.list().map((k) => [k.id, k.name]))
  let integrity: KbIntegrityReport = {
    orphanVectors: 0,
    orphanChunks: 0,
    brokenDocs: [],
    duplicates: [],
    providerIssues: []
  }
  try {
    integrity = getKbIntegrityReport()
  } catch { /* 探测失败按全空 */ }
  const kb = {
    total: docs.length,
    errorDocs: topErrorDocs(docs, (kbId) => kbNameById.get(kbId) ?? '(未知库)'),
    integrity,
    vectorIndex: getVectorIndexStats()
  }

  // 3. 备份状态（未配置 WebDAV 时 schedule 仍可读，lastRunAt 为 null）
  // §382：这一读要分三档——`!!loadWebDAVConfig()` 把「口令有密文却解不开」也算成"已配置"，
  // 而那一档下一次备份必在鉴权那步失败；取法必须是 readWebDAVConfig（判据排在密文被覆盖成明文之前）
  // §386：再加一档「那一行存在却读不出来」——它也让 configured 落成 false，但那不是"没配过"
  const wdRead = readWebDAVConfig()
  const configured = !!wdRead.cfg
  let backup: DataHealthReport['backup'] = {
    configured, passwordUndecryptable: wdRead.passwordUndecryptable, configUnreadable: wdRead.configUnreadable,
    enabled: false, intervalHours: 24,
    lastRunAt: null, lastOkAt: null, lastError: null
  }
  try {
    const s = getBackupSchedule()
    backup = {
      configured,
      passwordUndecryptable: wdRead.passwordUndecryptable,
      configUnreadable: wdRead.configUnreadable,
      enabled: s.enabled,
      intervalHours: s.intervalHours,
      lastRunAt: s.lastRunAt,
      lastOkAt: s.lastOkAt,
      lastError: s.lastResult && !s.lastResult.ok ? s.lastResult.error ?? '备份失败' : null
    }
  } catch (e) {
    backup.lastError = errMsg(e, '备份状态读取失败')
  }

  // 4. 内置维护任务上次运行时间
  const tasks = {
    kbHealthCheckLastRunAt: readLastRun('task.kb_health_check.last_run_at'),
    kbHealthCheckLastOk: readLastOk('task.kb_health_check.last_ok'),
    backupVerifyLastRunAt: readLastRun('task.backup_verify.last_run_at'),
    backupVerifyLastOk: readLastOk('task.backup_verify.last_ok')
  }

  return {
    sizes,
    approvals,
    kb,
    backup,
    tasks
  }
}
