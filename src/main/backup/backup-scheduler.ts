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
//   backup.last_run_at               毫秒时间戳
//   backup.last_result               JSON { ok, at, filename?, error? }

import { appConfigRepo } from '../db/repositories/app-config.repo'
import { masterKeyManager } from '../crypto/master-key'
import { loadWebDAVConfig, createWebDAVBackup } from './backup-service'
import { createLogger } from '../logger'
import { errMsg } from '../error'

const log = createLogger('backup-scheduler')

export interface BackupRunResult {
  ok: boolean
  at: number
  filename?: string
  error?: string
}

export interface BackupScheduleStatus {
  enabled: boolean
  intervalHours: number
  lastRunAt: number | null
  lastResult: BackupRunResult | null
}

const K_ENABLED = 'backup.schedule_enabled'
const K_INTERVAL = 'backup.schedule_interval_hours'
const K_LAST_RUN = 'backup.last_run_at'
const K_LAST_RESULT = 'backup.last_result'

const TICK_MS = 10 * 60 * 1000 // 10 分钟检查一次
const DEFAULT_INTERVAL_HOURS = 24

let timer: NodeJS.Timeout | null = null
let running = false

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
  return {
    enabled: appConfigRepo.get(K_ENABLED) === '1',
    intervalHours: Number.isFinite(intervalRaw) && intervalRaw > 0 ? intervalRaw : DEFAULT_INTERVAL_HOURS,
    lastRunAt: (() => {
      const v = Number(appConfigRepo.get(K_LAST_RUN))
      return Number.isFinite(v) && v > 0 ? v : null
    })(),
    lastResult: readResult()
  }
}

/** 更新调度配置；启用时把"上次执行"刷为当前时间，避免开启瞬间立即备份 */
export function setBackupSchedule(patch: { enabled?: boolean; intervalHours?: number }): BackupScheduleStatus {
  if (patch.enabled !== undefined) {
    appConfigRepo.set(K_ENABLED, patch.enabled ? '1' : '0')
    if (patch.enabled) appConfigRepo.set(K_LAST_RUN, String(Date.now()))
  }
  if (patch.intervalHours !== undefined && patch.intervalHours > 0) {
    appConfigRepo.set(K_INTERVAL, String(patch.intervalHours))
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
