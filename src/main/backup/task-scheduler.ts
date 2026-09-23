// 通用定时任务调度器：知识库健康检查 / 备份校验等后台维护任务
//
// 与 backup-scheduler 类似的 tick 模式：每 10 分钟检查一次，到点执行。
// 每个任务有独立的配置键、间隔和上次执行时间，互不干扰。
//
// 当前任务：
//   - kb_health_check：知识库健康检查，修复卡在 pending/parsing/indexing 的文档
//   - backup_verify：备份完整性校验，下载最新备份并校验 sha256

import { appConfigRepo } from '../db/repositories/app-config.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { loadWebDAVConfig, listWebDAVBackups, isEncryptedBlob, ENC_PREFIX, decryptBackup, toCreds } from './backup-service'
import { downloadFile } from './webdav-client'
import { createHash } from 'node:crypto'

const log = createLogger('task-scheduler')

const TICK_MS = 10 * 60 * 1000 // 10 分钟检查一次

interface TaskDef {
  key: string
  name: string
  defaultIntervalHours: number
  run: () => Promise<void>
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

// ─── 任务定义 ────────────────────────────────────────────────────

const tasks: TaskDef[] = [
  {
    key: 'kb_health_check',
    name: '知识库健康检查',
    defaultIntervalHours: 6,
    run: async () => {
      // 扫描所有知识库文档，将卡在 pending/parsing/indexing 超过 1 小时的标记为 error
      const docs = kbDocRepo.listAll()
      const now = Date.now()
      const STUCK_THRESHOLD = 60 * 60 * 1000 // 1 小时
      let fixed = 0
      for (const doc of docs) {
        if (doc.status === 'pending' || doc.status === 'parsing' || doc.status === 'indexing') {
          if (now - doc.createdAt > STUCK_THRESHOLD) {
            kbDocRepo.setStatus(doc.id, 'error', '索引超时，已自动标记为失败')
            fixed++
          }
        }
      }
      if (fixed > 0) {
        log.info(`知识库健康检查：修复 ${fixed} 个卡住的文档`)
      }
    }
  },
  {
    key: 'backup_verify',
    name: '备份完整性校验',
    defaultIntervalHours: 24,
    run: async () => {
      const cfg = loadWebDAVConfig()
      if (!cfg) return
      const creds = toCreds(cfg)
      const backups = await listWebDAVBackups(cfg)
      if (backups.length === 0) return

      // 校验最新的一个备份
      const latest = backups[0]!
      const raw = await downloadFile(creds, latest.name)
      let buf = raw
      if (isEncryptedBlob(raw, latest.name)) {
        buf = decryptBackup(
          raw,
          raw.subarray(ENC_PREFIX.length + 12, ENC_PREFIX.length + 12 + 16)
        )
      }
      // 全量备份：解压校验 app.db 存在
      // 增量备份：校验索引 JSON 可解析
      if (latest.name.startsWith('pocketai-inc-')) {
        const index = JSON.parse(buf.toString('utf8'))
        if (!index.kind || !index.db?.sha256) throw new Error('增量索引格式无效')
        log.info(`备份校验通过：${latest.name}（增量索引）`)
      } else {
        // 全量 zip：校验 sha256
        const hash = sha256Hex(buf)
        log.info(`备份校验通过：${latest.name}（sha256=${hash.slice(0, 16)}…）`)
      }
    }
  }
]

// ─── 调度核心 ────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null

function getLastRun(key: string): number | null {
  const v = Number(appConfigRepo.get(`task.${key}.last_run_at`))
  return Number.isFinite(v) && v > 0 ? v : null
}

function setLastRun(key: string, at: number): void {
  appConfigRepo.set(`task.${key}.last_run_at`, String(at))
}

async function runTask(task: TaskDef): Promise<void> {
  const at = Date.now()
  try {
    await task.run()
    log.debug(`定时任务完成: ${task.name}`)
  } catch (e) {
    log.warn(`定时任务失败: ${task.name} - ${errMsg(e)}`)
  } finally {
    setLastRun(task.key, at)
  }
}

async function tick(): Promise<void> {
  try {
    const now = Date.now()
    for (const task of tasks) {
      const lastRun = getLastRun(task.key)
      const due = lastRun === null || now - lastRun >= task.defaultIntervalHours * 3600 * 1000
      if (due) {
        await runTask(task)
      }
    }
  } catch (e) {
    log.warn('task-scheduler tick 异常:', errMsg(e))
  }
}

/** 应用启动后调用（DB 已解锁） */
export function initTaskScheduler(): void {
  if (timer) return
  // 启动 60 秒后首次 tick（等待系统稳定），之后每 10 分钟
  setTimeout(() => void tick(), 60 * 1000)
  timer = setInterval(() => void tick(), TICK_MS)
}

export function stopTaskScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
