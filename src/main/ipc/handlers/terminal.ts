// 终端模块 IPC
import { z } from 'zod'
import { IPC } from '../../../shared/types'
import { safeHandle, argsSchema, argFail } from '../safe-handle'
import { startTerminal, inputTerminal, killTerminal } from '../../terminal/terminal-service'

const terminalStartSchema = z.object({
  cwd: z.string().min(1).max(4096).optional()
})
const terminalInputSchema = z.object({
  data: z.string().max(8 * 1024)
})

export function registerTerminalHandlers(): void {
  // 启动参数可选：不传时主进程按「工作目录 > APP_ROOT/用户目录」解析。
  // 走 safeParse + argFail 与 argsSchema 的失败形状保持一致（中文原因 + 回码）。
  safeHandle(IPC.TERMINAL_START, (e, input?: unknown) => {
    const parsed = terminalStartSchema.safeParse(input ?? {})
    if (!parsed.success) return argFail(parsed.error.issues)
    return startTerminal(e.sender, parsed.data.cwd)
  })
  safeHandle(
    IPC.TERMINAL_INPUT,
    (e, input: { data: string }) => inputTerminal(e.sender.id, input.data),
    argsSchema(terminalInputSchema)
  )
  safeHandle(IPC.TERMINAL_KILL, (e) => {
    killTerminal(e.sender.id)
    return { ok: true }
  })
}
