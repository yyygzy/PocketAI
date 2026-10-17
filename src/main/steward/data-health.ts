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
import type { DataHealthReport, KbDocStatus, KbDocument, KbIntegrityReport } from '../../shared/types'
import { isBrowserProfilePath } from '../../shared/data-dirs'
import { DATA_DIR } from '../portable'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { kbRepo } from '../db/repositories/kb.repo'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { agentTraceRepo } from '../db/repositories/agent-trace.repo'
import { loadWebDAVConfig } from '../backup/backup-service'
import { getBackupSchedule } from '../backup/backup-scheduler'
import { errMsg } from '../error'
import { getBootPerf } from './boot-perf'
import { getRecentPerf } from './perf-probe'
import { getPerfHistory } from './perf-history'
import { getKbIntegrityReport, getVectorIndexStats } from '../knowledge/kb-health'

// ─── 纯函数：数据目录体积分类聚合 ────────────────────────────────

export type DataBucket = 'db' | 'attachments' | 'extensions' | 'logs' | 'browserCache' | 'other'

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
  return 'other'
}

export interface DataSizeEntry {
  /** 相对 DATA_DIR 的路径（/ 分隔） */
  rel: string
  bytes: number
}

/** 体积条目按桶聚合 → DataHealthReport.sizes（合计只算用户数据，浏览器缓存单列） */
export function aggregateDataSizes(entries: DataSizeEntry[]): DataHealthReport['sizes'] {
  const buckets: Record<DataBucket, number> = {
    db: 0, attachments: 0, extensions: 0, logs: 0, browserCache: 0, other: 0
  }
  let cacheFiles = 0
  for (const e of entries) {
    const b = classifyDataEntry(e.rel)
    buckets[b] += e.bytes
    if (b === 'browserCache') cacheFiles++
  }
  return {
    userDataBytes: buckets.db + buckets.attachments + buckets.extensions + buckets.logs + buckets.other,
    dbBytes: buckets.db,
    attachmentsBytes: buckets.attachments,
    extensionsBytes: buckets.extensions,
    logsBytes: buckets.logs,
    otherBytes: buckets.other,
    browserCacheBytes: buckets.browserCache,
    browserCacheFiles: cacheFiles
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

/**
 * 递归收集目录下全部文件的相对路径与体积；单项 stat 失败忽略。
 *
 * `mode` 是 V4-Iter-177 的性能接缝：`skipProfile` 用于每次都要新鲜的"用户数据"明细
 * （一个文件都不 stat 那两棵 Chromium 档案树），`onlyProfile` 只走档案树、结果由上层按进程缓存。
 * 判据用**相对路径的首段**，所以子项（`userdata/Cache/...`）在两种模式下都会被同一棵树带走。
 */
function walkEntries(dir: string, base: string, out: DataSizeEntry[], mode: 'skipProfile' | 'onlyProfile'): void {
  let items: import('node:fs').Dirent[]
  try {
    items = readdirSync(dir, { withFileTypes: true })
  } catch {
    return // 目录不存在/不可读 → 该桶按 0 处理
  }
  for (const it of items) {
    const full = path.join(dir, it.name)
    const rel = path.relative(base, full).replaceAll('\\', '/')
    const profile = isBrowserProfilePath(rel)
    if (mode === 'skipProfile' && profile) continue
    if (mode === 'onlyProfile' && !profile) continue
    if (it.isDirectory()) {
      walkEntries(full, base, out, mode)
    } else if (it.isFile()) {
      try {
        out.push({ rel, bytes: statSync(full).size })
      } catch { /* 竞态删除/权限 → 跳过该文件 */ }
    }
  }
}

/** 用户数据明细（不含浏览器档案树）——每次都现走，附件/日志这类会变的量必须新鲜 */
export function collectUserDataEntries(): DataSizeEntry[] {
  const out: DataSizeEntry[] = []
  walkEntries(DATA_DIR, DATA_DIR, out, 'skipProfile')
  return out
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

export function getBrowserCacheStats(refresh: boolean): BrowserCacheStats {
  if (refresh || !browserCacheMemo) {
    const out: DataSizeEntry[] = []
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

  // 1b. Agent 运行账本（agent_traces）规模：总行数 + 单个会话最多行数。
  //     后者贵一些（200,000 行实测 16 ms，要逐行数），所以只在这一屏被打开时算一次。
  const traces = agentTraceRepo.countForHealth()

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
    byStatus: groupDocStatus(docs),
    errorDocs: topErrorDocs(docs, (kbId) => kbNameById.get(kbId) ?? '(未知库)'),
    integrity,
    vectorIndex: getVectorIndexStats()
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

  // 5. 本次启动各阶段耗时（内存埋点即时快照）
  const boot = getBootPerf()

  // 6. 运行期慢操作（入库/检索/渲染长任务，环形缓冲快照）
  const recentPerf = getRecentPerf()

  // 7. 跨会话慢事件（从日志尾部聚合，只下发统计行）
  const perfHistory = getPerfHistory()

  return { sizes, traces, kb, backup, tasks, boot, recentPerf, perfHistory }
}
