// 退出管理器：集中处理退出流程，避免 tray ↔ index 循环依赖
import { app } from 'electron'
import { mcpManager } from './mcp/manager'
import { ollamaRuntime } from './ollama/ollama-runtime'
import { stopBackupScheduler } from './backup/backup-scheduler'
import { stopTaskScheduler } from './backup/task-scheduler'
import { stopReminderScheduler } from './reminder/scheduler'
import { killAllTerminals } from './terminal/terminal-service'
import { dbService } from './db/database'
import { createLogger } from './logger'

const log = createLogger('quit')

/** 退出流程中：防止 close 事件重复弹窗，也让 tray 退出菜单跳过弹窗 */
let quitting = false
export function isQuitting(): boolean { return quitting }

/** 托盘/菜单触发退出：设标志跳过弹窗，走 before-quit 清理链 */
export function requestQuit(): void {
  quitting = true
  app.quit()
}

/** 主窗口 close 确认后触发 */
export function beginQuit(): void {
  quitting = true
  app.quit()
}

/**
 * 异步清理链（before-quit 调用）。
 * 按顺序停止所有子进程，确保 app.exit() 之前真正执行完毕。
 * 顺序：abortPull → await mcpManager.stopAll → ollamaRuntime.cleanup → 三个 scheduler（backup/task/reminder）→ db
 */
// V4-Iter-197：`quiting` 表示「别再弹确认框」，它不等于「清理链跑过了」。两个含义共用一个标志
// 的后果是：托盘退出与关窗确认这两条路径在 before-quit 第一行就被挡回，唯一 await
// mcpManager.stopAll() 的那一步根本不跑 ⇒ MCP stdio 子进程成孤儿。下面这对标志把两件事分开。
let chainStarted = false
let chainDone = false

/** 清理链是否已经结束（跑完或超时放行）——before-quit 只该用这个判断要不要放行真正退出 */
export function isCleanupDone(): boolean {
  return chainDone
}

/**
 * 幂等地跑一次清理链，并给它一个总时限：链里任何一步挂住（最典型是 stopAll 等子进程应答）
 * 都不能把退出流程永久钉住——那比不清理更糟（用户只会看到「点了退出没反应」）。
 */
export async function runCleanupOnce(timeoutMs = 10_000): Promise<'done' | 'timeout'> {
  if (chainStarted) {
    await Promise.resolve()
    return chainDone ? 'done' : 'timeout'
  }
  chainStarted = true
  const chain = runCleanupChain().then(
    () => 'done' as const,
    (err) => {
      log.warn('清理链异常（按完成处理，不阻塞退出）:', err)
      return 'done' as const
    }
  ).finally(() => {
    chainDone = true
  })
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const raced = await Promise.race([chain, guard])
  if (timer) clearTimeout(timer)
  if (raced === 'timeout') log.warn(`清理链超过 ${timeoutMs}ms 未完成，按超时放行退出`)
  return raced
}

export async function runCleanupChain(): Promise<void> {
  log.info('before-quit → 异步清理链开始')
  try {
    // 1. 中止正在进行的模型下载（HTTP 长连接必须先断）
    ollamaRuntime.abortPull()
  } catch { /* ignore */ }
  try {
    // 2. 停 MCP 服务器（shutdown → SIGTERM → 超时 SIGKILL）
    await mcpManager.stopAll()
  } catch (err) {
    log.warn('mcpManager.stopAll 异常:', err)
  }
  try {
    // 3. 停 Ollama serve（killTree 整树终止）
    ollamaRuntime.cleanup()
  } catch (err) {
    log.warn('ollamaRuntime.cleanup 异常:', err)
  }
  try { stopBackupScheduler() } catch { /* ignore */ }
  try { stopTaskScheduler() } catch { /* ignore */ }
  // 提醒调度器（V4-Iter-199）：30s tick 会读库，跟另外两个调度器一样停在 close 之前
  try { stopReminderScheduler() } catch { /* ignore */ }
  try { killAllTerminals() } catch { /* ignore */ }
  try { dbService.close() } catch { /* ignore */ }
  log.info('清理链完成')
}

/** 兜底同步清理（will-quit 极端情况调用） */
export function runFallbackCleanup(): void {
  try { ollamaRuntime.abortPull() } catch { /* ignore */ }
  try { ollamaRuntime.cleanup() } catch { /* ignore */ }
  try { stopBackupScheduler() } catch { /* ignore */ }
  try { stopTaskScheduler() } catch { /* ignore */ }
  // 提醒调度器（V4-Iter-199）：30s tick 会读库，跟另外两个调度器一样停在 close 之前
  try { stopReminderScheduler() } catch { /* ignore */ }
  try { killAllTerminals() } catch { /* ignore */ }
  // 197：兜底路径也试一次停 MCP（fire-and-forget，进程可能马上就退了，但比不试好）
  try {
    void mcpManager.stopAll().catch(() => { /* ignore */ })
  } catch { /* ignore */ }
  try { dbService.close() } catch { /* ignore */ }
}
