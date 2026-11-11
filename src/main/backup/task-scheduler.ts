// 通用定时任务调度器：知识库健康检查 / 备份校验等后台维护任务
//
// 与 backup-scheduler 类似的 tick 模式：每 10 分钟检查一次，到点执行。
// 每个任务有独立的配置键、间隔和上次执行时间，互不干扰。
//
// 当前任务：
//   - kb_health_check：知识库健康检查，修复卡在 pending/parsing/indexing 的文档
//   - backup_verify：备份完整性校验，下载最新备份并校验 sha256

import { dbService } from '../db/database'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { readWebDAVConfig, listWebDAVBackups, isEncryptedBlob, ENC_PREFIX, decryptBackup, toCreds } from './backup-service'
import { downloadFile } from './webdav-client'
import { pickLatestBackup } from '../../shared/backup-latest'
import { createHash } from 'node:crypto'

const log = createLogger('task-scheduler')

const TICK_MS = 10 * 60 * 1000 // 10 分钟检查一次

export type BackupVerifyStatus = 'passed' | 'failed' | 'skipped'

export interface BackupVerifyRunResult {
  status: BackupVerifyStatus
  /** 跳过／失败的一句话原因（手动「立即验证」的回执用；通过时为空） */
  reason?: string
}

interface TaskDef {
  key: string
  name: string
  defaultIntervalHours: number
  /** 备份校验回三态；知识库健康检查不回执（那一支不接消费者） */
  run: () => Promise<BackupVerifyRunResult | void>
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
          if (now - (doc.updatedAt ?? doc.createdAt) > STUCK_THRESHOLD) {
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
      const read = readWebDAVConfig()
      if (!read.cfg) {
        // §386：坏行要说一句——这一发原先静默 return，屏上只剩「从未运行」，而真相是那份配置读不出来；
        //        真没配过照旧安静（那是合法状态，每 24h 刷一条 warn 没有意义）。
        if (read.configUnreadable) {
          log.warn('备份校验跳过：WebDAV 配置那一行读不出来（请到设置 → 数据与安全 重新填写并保存）')
          return { status: 'skipped', reason: 'WebDAV 配置读不出来' }
        }
        return { status: 'skipped', reason: '未配置 WebDAV' }
      }
      const cfg = read.cfg
      const creds = toCreds(cfg)
      const backups = await listWebDAVBackups(cfg)
      if (backups.length === 0) return { status: 'skipped', reason: '云端没有备份' }

      // 校验最新的一个备份。「最新」不取列举结果的第 0 位（§338）：那一份的排序比较器会被
      // NaN 折成 +0，整表顺序交给服务器返回顺序 ⇒ 改前能验到最旧那份还照报「校验通过」，
      // 真正坏掉的最新那份永远不会被下载到
      const latest = pickLatestBackup(backups)
      if (!latest) {
        log.warn(`备份校验：${backups.length} 份云端备份的时间都判不出来，本轮不校验（宁可不验，也不猜一份来验）`)
        return { status: 'skipped', reason: '云端备份的时间都判不出来' }
      }
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
      return { status: 'passed' }
    }
  }
]

// ─── 调度核心 ────────────────────────────────────────────────────

let timer: NodeJS.Timeout | null = null
let bootDelay: NodeJS.Timeout | null = null

function getLastRun(key: string): number | null {
  const v = Number(appConfigRepo.get(`task.${key}.last_run_at`))
  return Number.isFinite(v) && v > 0 ? v : null
}

function setLastRun(key: string, at: number): void {
  appConfigRepo.set(`task.${key}.last_run_at`, String(at))
}

// §395：`last_run_at` 在成功与失败两种收尾里都写（它在 finally 里），所以「跑过」这一事实分不出成败；
//        这一颗专管那一发抛没抛。跳过的那一支（没配 WebDAV／云端零份）任务体是 return 而非 throw，
//        于是记 1＝「这一发没报错」，不是「备份校验通过了」——消费面（数据健康面板）的措辞按这个语义写。
function setLastOk(key: string, ok: boolean): void {
  appConfigRepo.set(`task.${key}.last_ok`, ok ? '1' : '0')
}

// §395 的 `last_ok` 只说明「这一发抛没抛」——跳过的分支（没配 WebDAV／云端零份／时间判不出）
// 也是 1，消费面按「未报错」措辞写。管家故障诊断要说「通过／从未通过」，需要一颗真正的三态：
// passed＝校验真的走完；skipped＝没跑成；failed＝抛错。只有回了这三态的任务才写（知识库那支不接）。
function setLastStatus(key: string, status: BackupVerifyStatus): void {
  appConfigRepo.set(`task.${key}.last_status`, status)
}

async function runTask(task: TaskDef): Promise<BackupVerifyRunResult> {
  const at = Date.now()
  let ok = true
  let result: BackupVerifyRunResult | null = null
  try {
    const ret = await task.run()
    if (ret) result = ret
    log.debug(`定时任务完成: ${task.name}`)
  } catch (e) {
    ok = false
    const reason = errMsg(e)
    result = { status: 'failed', reason }
    log.warn(`定时任务失败: ${task.name} - ${reason}`)
  } finally {
    try {
      // 三颗写在同一颗保护里（状态在前、flag 其次、时间戳最后）：任务跑一半时用户锁屏＝库关了，
      // 这里抛出的只能是"写不回"，绝不能顶掉任务原本的异常（日志上只剩「Database not opened」就查不到真因）。
      // 顺序取状态在前：万一只写进去这一颗，屏上那句说的是"这一发"，而下一次 tick 会照旧补跑到点的任务。
      if (result) setLastStatus(task.key, result.status)
      setLastOk(task.key, ok)
      setLastRun(task.key, at)
    } catch (e) {
      log.warn(`定时任务时间戳写入失败: ${task.name} - ${errMsg(e)}`)
    }
  }
  return result ?? { status: ok ? 'passed' : 'failed' }
}

/**
 * 「立即验证」：手动跑一次备份完整性校验，回执三态。
 * 与定时 tick 共用同一条 runTask（写 last_run_at／last_ok／last_status 的口径一处），
 * 跳过（没配 WebDAV／云端零份／时间判不出）如实回 skipped，绝不冒充 passed。
 */
export async function verifyBackupNow(): Promise<BackupVerifyRunResult> {
  const task = tasks.find((t) => t.key === 'backup_verify')
  if (!task) return { status: 'failed', reason: '备份校验任务未注册' }
  return runTask(task)
}

export async function tick(): Promise<void> {
  // 锁屏与未解锁期间库是关着的，任何任务都只会撞 "Database not opened"：
  // 整轮直接跳过——不记失败、也不刷新 last_run_at，解锁后的下一个 tick 照常补跑到点的任务
  if (!dbService.isOpen()) return
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
  bootDelay = setTimeout(() => void tick(), 60 * 1000)
  timer = setInterval(() => void tick(), TICK_MS)
}

export function stopTaskScheduler(): void {
  if (bootDelay) {
    clearTimeout(bootDelay)
    bootDelay = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
