// 共享数据目录的进程锁（P3）：移动硬盘同一时间只允许一个客户端写同一份 data/。
// 锁文件带心跳，跨机器无法靠 PID 判活，因此超过 STALE_MS 未续期即视为陈旧并接管。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DATA_DIR } from './portable'
import { createLogger } from './logger'

const log = createLogger('data-lock')
const LOCK_FILE = path.join(DATA_DIR, '.lock')
const STALE_MS = 60_000
const HEARTBEAT_MS = 15_000

interface LockInfo {
  platform: NodeJS.Platform
  hostname: string
  pid: number
  startedAt: number
  heartbeatAt: number
}

export interface DataLock {
  release(): void
}

function readLock(): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')) as Partial<LockInfo>
    if (
      typeof parsed.startedAt !== 'number' ||
      typeof parsed.heartbeatAt !== 'number'
    ) return null
    return parsed as LockInfo
  } catch {
    return null
  }
}

function writeLock(info: LockInfo): void {
  const tmp = `${LOCK_FILE}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), 'utf8')
  fs.renameSync(tmp, LOCK_FILE)
}

/**
 * 尝试独占共享数据目录；拿不到锁返回 null（调用方应提示并退出）。
 * 进程正常退出、release() 或 heartbeat 失败时都会释放自己的锁。
 */
export function acquireDataLock(): DataLock | null {
  const now = Date.now()
  const existing = readLock()
  if (existing && now - existing.heartbeatAt < STALE_MS) {
    log.warn(`共享数据目录已被占用：${existing.hostname} / ${existing.platform} / PID ${existing.pid}`)
    return null
  }

  const info: LockInfo = {
    platform: process.platform,
    hostname: os.hostname(),
    pid: process.pid,
    startedAt: now,
    heartbeatAt: now
  }
  let released = false
  let timer: NodeJS.Timeout | null = null
  const release = (): void => {
    if (released) return
    released = true
    if (timer) clearInterval(timer)
    try {
      const current = readLock()
      if (current && current.pid === info.pid && current.startedAt === info.startedAt) {
        fs.unlinkSync(LOCK_FILE)
      }
    } catch {
      // 退出路径上释放失败只告警，不能影响退出
    }
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    writeLock(info)
  } catch (e) {
    log.error(`写入共享数据目录锁失败: ${String(e)}`)
    return null
  }

  timer = setInterval(() => {
    if (released) return
    try {
      info.heartbeatAt = Date.now()
      writeLock(info)
    } catch {
      log.warn('共享数据目录锁心跳失败，释放本进程锁')
      release()
    }
  }, HEARTBEAT_MS)
  timer.unref()

  process.once('exit', release)
  return { release }
}
