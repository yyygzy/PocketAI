// 定时 WebDAV 备份调度器
//
// 策略：
// - 每 10 分钟 tick 一次，读取 app_config 中的开关与间隔
// - 到点且满足条件时静默执行 createWebDAVBackup()（try/catch，绝不弹窗）
// - 跳过条件：未启用 / 未配置 WebDAV / 隐私锁锁定中（DB 已关闭）/ 已有备份在跑
// - 上次执行时间与结果持久化到 app_config，供设置页展示
//
// 配置键：
//   backup.schedule_enabled          '1' | '0'
//   backup.schedule_interval_hours   数字字符串，默认 24
//   backup.retention_count           保留最近 N 份全量包，0=不自动清理（默认）
//   backup.last_run_at               毫秒时间戳
//   backup.last_result               JSON { ok, at, filename?, pruned?, error? }

import { appConfigRepo } from '../db/repositories/app-config.repo'
import { masterKeyManager } from '../crypto/master-key'
import { loadWebDAVConfig, createWebDAVBackup, listWebDAVBackups, deleteWebDAVBackup } from './backup-service'
import type { WebDAVBackupFile } from '../../shared/types'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('backup-scheduler')

export interface BackupRunResult {
  ok: boolean
  at: number
  filename?: string
  /** 本次成功后轮转删除的旧全量包份数 */
  pruned?: number
  error?: string
}

export interface BackupScheduleStatus {
  enabled: boolean
  intervalHours: number
  /** 保留最近 N 份全量包，0=不自动清理 */
  retentionCount: number
  lastRunAt: number | null
  lastResult: BackupRunResult | null
}

const K_ENABLED = 'backup.schedule_enabled'
const K_INTERVAL = 'backup.schedule_interval_hours'
const K_RETENTION = 'backup.retention_count'
const K_LAST_RUN = 'backup.last_run_at'
const K_LAST_RESULT = 'backup.last_result'

const TICK_MS = 10 * 60 * 1000 // 10 分钟检查一次
const DEFAULT_INTERVAL_HOURS = 24
/** 保留份数上限（防误配置成超大值；超上限的清理请求无意义且危险） */
const MAX_RETENTION = 100

let timer: NodeJS.Timeout | null = null
let running = false

/**
 * 轮转决策纯函数：从远端备份清单中选出应删除的旧**全量**包文件名（最旧的在前）。
 * - keep<=0 关闭轮转 → []
 * - 只处理 kind==='full'：incremental 索引引用内容寻址 blob，绝不能按份数盲删
 * - 按 mtime 倒序（防御列举结果乱序），保留最新 keep 份（含本次新包），其余入删除列表
 * - justUploaded 再做一次兜底排除：新包即使因 WebDAV 时钟漂移 mtime 异常落入待删区也绝不删
 */
export function selectPrunableBackups(
  files: Pick<WebDAVBackupFile, 'name' | 'mtime' | 'kind'>[],
  keep: number,
  justUploaded?: string
): string[] {
  if (!Number.isFinite(keep) || keep <= 0) return []
  const full = files
    .filter((f) => f.kind === 'full')
    .slice()
    .sort((a, b) => b.mtime - a.mtime)
  // 最旧优先删除：若中途失败/取消，留在远端的也是相对较新的包
  return full
    .slice(keep)
    .filter((f) => f.name !== justUploaded)
    .reverse()
    .map((f) => f.name)
}

function readResult(): BackupRunResult | null {
  const raw = appConfigRepo.get(K_LAST_RESULT)
  if (!raw) return null
  try {
    return JSON.parse(raw) as BackupRunResult
  } catch {
    return null
  }
}

export function getBackupSchedule(): BackupScheduleStatus {
  const intervalRaw = Number(appConfigRepo.get(K_INTERVAL))
  const retentionRaw = Math.trunc(Number(appConfigRepo.get(K_RETENTION)))
  return {
    enabled: appConfigRepo.get(K_ENABLED) === '1',
    intervalHours: Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : DEFAULT_INTERVAL_HOURS,
    retentionCount: Number.isFinite(retentionRaw) && retentionRaw > 0 ? Math.min(retentionRaw, MAX_RETENTION) : 0,
    lastRunAt: (() => {
      const v = Number(appConfigRepo.get(K_LAST_RUN))
      return Number.isFinite(v) && v > 0 ? v : null
    })(),
    lastResult: readResult()
  }
}

/** 更新调度配置；启用时把"上次执行"刷为当前时间，避免开启瞬间立即备份 */
export function setBackupSchedule(patch: { enabled?: boolean; intervalHours?: number; retentionCount?: number }): BackupScheduleStatus {
  if (patch.enabled !== undefined) {
    appConfigRepo.set(K_ENABLED, patch.enabled ? '1' : '0')
    if (patch.enabled) appConfigRepo.set(K_LAST_RUN, String(Date.now()))
  }
  if (patch.intervalHours !== undefined && patch.intervalHours > 0) {
    appConfigRepo.set(K_INTERVAL, String(patch.intervalHours))
  }
  if (patch.retentionCount !== undefined) {
    const n = Math.trunc(patch.retentionCount)
    if (n >= 0 && n <= MAX_RETENTION) appConfigRepo.set(K_RETENTION, String(n))
  }
  return getBackupSchedule()
}

/** 执行一次定时备份；running 互斥防止重叠 */
export async function runScheduledBackup(): Promise<BackupRunResult | null> {
  if (running) return null
  running = true
  const at = Date.now()
  let result: BackupRunResult
  try {
    const cfg = loadWebDAVConfig()
    if (!cfg) throw new Error('未配置 WebDAV')
    const r = await createWebDAVBackup(cfg)
    result = { ok: true, at, filename: r.filename }
    log.info(`定时备份成功: ${r.filename}`)
    // 备份成功后按保留份数轮转旧全量包；整段失败不改变备份成功结论
    result.pruned = await pruneOldBackups(cfg, r.filename)
  } catch (e) {
    result = { ok: false, at, error: errMsg(e, '备份失败') }
    log.warn(`定时备份失败: ${result.error}`)
  } finally {
    running = false
  }
  appConfigRepo.set(K_LAST_RUN, String(at))
  appConfigRepo.set(K_LAST_RESULT, JSON.stringify(result))
  return result
}

/**
 * 按保留份数清理旧全量包，返回成功删除数。
 * retentionCount<=0 直接跳过；列举/单个删除失败只 warn 不抛出（不连累备份结果）。
 */
async function pruneOldBackups(
  cfg: ReturnType<typeof loadWebDAVConfig>,
  justUploaded: string
): Promise<number> {
  const keep = getBackupSchedule().retentionCount
  if (keep <= 0 || !cfg) return 0
  try {
    const files = await listWebDAVBackups(cfg)
    const prunable = selectPrunableBackups(files, keep, justUploaded)
    let pruned = 0
    for (const name of prunable) {
      try {
        await deleteWebDAVBackup(cfg, name)
        pruned++
      } catch (e) {
        log.warn(`轮转删除旧备份失败 ${name}: ${errMsg(e)}`)
      }
    }
    if (pruned > 0) log.info(`备份轮转：清理 ${pruned}/${prunable.length} 份旧全量包（保留 ${keep} 份）`)
    return pruned
  } catch (e) {
    log.warn(`备份轮转跳过: ${errMsg(e)}`)
    return 0
  }
}

/** 手动上传备份后调用，避免调度器紧接着重复备份 */
export function noteManualBackup(): void {
  appConfigRepo.set(K_LAST_RUN, String(Date.now()))
}

export async function tick(): Promise<void> {
  try {
    const status = getBackupSchedule()
    if (!status.enabled) return
    // 隐私锁锁定中：加密库已关闭，跳过
    if (masterKeyManager.getMode() === 'db' && !masterKeyManager.hasKey()) return
    if (!loadWebDAVConfig()) return
    const now = Date.now()
    const due =
      status.lastRunAt === null
        ? true // 启用但从未记录过执行时间 → 补一次
        : now - status.lastRunAt >= status.intervalHours * 3600 * 1000
    if (!due) return
    await runScheduledBackup()
  } catch (e) {
    log.warn('tick 异常:', errMsg(e))
  }
}

/** 应用启动后调用（DB 已解锁、IPC 已注册） */
export function initBackupScheduler(): void {
  if (timer) return
  // 启动 30 秒后做首次检查（错过的间隔可补备份），之后每 10 分钟轮询
  setTimeout(() => void tick(), 30 * 1000)
  timer = setInterval(() => void tick(), TICK_MS)
}

export function stopBackupScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
