// 退出管理器：集中处理退出流程，避免 tray ↔ index 循环依赖
import { app } from 'electron'
import { mcpManager } from './mcp/manager'
import { ollamaRuntime } from './ollama/ollama-runtime'
import { stopBackupScheduler } from './backup/backup-scheduler'
import { dbService } from './db/database'

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
 * 顺序：abortPull → await mcpManager.stopAll → ollamaRuntime.cleanup → scheduler → db
 */
export async function runCleanupChain(): Promise<void> {
  console.log('[quit] before-quit → 异步清理链开始')
  try {
    // 1. 中止正在进行的模型下载（HTTP 长连接必须先断）
    ollamaRuntime.abortPull()
  } catch { /* ignore */ }
  try {
    // 2. 停 MCP 服务器（shutdown → SIGTERM → 超时 SIGKILL）
    await mcpManager.stopAll()
  } catch (err) {
    console.warn('[quit] mcpManager.stopAll 异常:', err)
  }
  try {
    // 3. 停 Ollama serve（killTree 整树终止）
    ollamaRuntime.cleanup()
  } catch (err) {
    console.warn('[quit] ollamaRuntime.cleanup 异常:', err)
  }
  try { stopBackupScheduler() } catch { /* ignore */ }
  try { dbService.close() } catch { /* ignore */ }
  console.log('[quit] 清理链完成')
}

/** 兜底同步清理（will-quit 极端情况调用） */
export function runFallbackCleanup(): void {
  try { ollamaRuntime.abortPull() } catch { /* ignore */ }
  try { ollamaRuntime.cleanup() } catch { /* ignore */ }
  try { stopBackupScheduler() } catch { /* ignore */ }
  try { dbService.close() } catch { /* ignore */ }
}
