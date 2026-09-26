// 定时提醒调度器：30s tick 扫描到期提醒，到点系统通知 + 广播渲染端
// 不复用 task-scheduler（10 分钟周期 tick）——提醒需要分钟级精度
import { Notification } from 'electron'
import { IPC } from '../../shared/types'
import type { ReminderFiredPayload } from '../../shared/types'
import { reminderRepo } from '../db/repositories/reminder.repo'
import { broadcast } from '../ipc/broadcast'
import { createLogger } from '../logger'

const log = createLogger('reminder')

const TICK_MS = 30_000

let timer: NodeJS.Timeout | null = null

/** 触发一条到期提醒：系统通知 + 广播 + 状态翻转（失败不中断后续条目） */
function fireOne(r: { id: string; text: string; fireAt: number }): void {
  try {
    if (Notification.isSupported()) {
      new Notification({ title: 'PocketAI 提醒', body: r.text }).show()
    }
    const payload: ReminderFiredPayload = { id: r.id, text: r.text, fireAt: r.fireAt }
    broadcast(IPC.REMINDER_FIRED, payload)
    reminderRepo.markFired(r.id)
    log.info(`提醒已触发: ${r.id}`)
  } catch (e) {
    log.warn(`提醒触发失败: ${r.id}`, e)
  }
}

function tick(): void {
  let due
  try {
    due = reminderRepo.listDue(Date.now())
  } catch (e) {
    // DB 关闭（隐私锁 db 模式锁屏时关库）：本轮跳过，解锁后下个 tick 会补触发
    log.debug('扫描到期提醒失败（可能已锁屏）', e)
    return
  }
  for (const r of due) fireOne(r)
}

/** 启动恢复：已过期 pending 标 missed 并汇总广播一条（不逐个弹通知防轰炸） */
function recoverMissed(): void {
  let expired
  try {
    expired = reminderRepo.listDue(Date.now())
  } catch (e) {
    log.warn('启动恢复扫描失败', e)
    return
  }
  if (expired.length === 0) return
  for (const r of expired) {
    try {
      reminderRepo.markMissed(r.id)
    } catch (e) {
      log.warn(`标记 missed 失败: ${r.id}`, e)
    }
  }
  const payload: ReminderFiredPayload = { missed: expired.length }
  broadcast(IPC.REMINDER_FIRED, payload)
  log.info(`启动恢复：${expired.length} 条过期提醒已标记 missed`)
}

export function initReminderScheduler(): void {
  if (timer) return
  recoverMissed()
  timer = setInterval(tick, TICK_MS)
  log.info('定时提醒调度器已启动（30s tick）')
}

/** 测试与退出清理用 */
export function stopReminderScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
