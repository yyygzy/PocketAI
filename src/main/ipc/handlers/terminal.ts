// 终端模块 IPC
import { z } from 'zod'
import { IPC } from '../../../shared/types'
import { safeHandle, argsSchema } from '../safe-handle'
import { startTerminal, inputTerminal, killTerminal } from '../../terminal/terminal-service'

const terminalInputSchema = z.object({
  data: z.string().max(8 * 1024)
})

export function registerTerminalHandlers(): void {
  safeHandle(IPC.TERMINAL_START, (e) => startTerminal(e.sender))
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
