// 用户手动终端服务（终端模块后端，非 Agent 工具）
//
// 与 shell_exec 工具的区别：
//  - shell_exec：Agent 驱动，一次性命令，需工作目录锚定 + confirm/allow 分类审批；
//  - 本服务：用户自己操作（等价于系统终端），长生命周期交互式 shell 子进程，
//    输出流式推送渲染端；安全上仅保留 deny 黑名单硬拒（classifyDenyOnly），
//    因为用户本身就有能力打开系统终端，confirm 审批对「用户本人」无意义。
//
// 生命周期：每个渲染窗口（webContentsId）最多一个 session；窗口销毁/模块 kill 时清理。
import { spawn, type ChildProcess } from 'node:child_process'
import type { WebContents } from 'electron'
import { IPC } from '../../shared/types'
import { classifyDenyOnly } from '../tools/shell-tools'
import { createLogger } from '../logger'

const log = createLogger('terminal')

interface TerminalSession {
  proc: ChildProcess
  /** 窗口 id（输出推送目标） */
  ownerId: number
}

const sessions = new Map<number, TerminalSession>()

/** 当前平台的交互式 shell 启动命令 */
function shellCommand(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'cmd.exe', args: [] }
  return { cmd: process.env.SHELL || '/bin/sh', args: ['-i'] }
}

/** 启动终端 session（同窗口重复调用先杀旧的） */
export function startTerminal(wc: WebContents): { ok: boolean; sessionId?: number; error?: string } {
  const ownerId = wc.id
  killTerminal(ownerId)
  const { cmd, args } = shellCommand()
  let proc: ChildProcess
  try {
    proc = spawn(cmd, args, {
      cwd: undefined, // 继承应用工作目录（便携包根目录）
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (e) {
    return { ok: false, error: `终端启动失败：${e instanceof Error ? e.message : String(e)}` }
  }
  if (!proc.stdin || !proc.stdout || !proc.stderr) {
    return { ok: false, error: '终端进程管道不可用' }
  }

  const push = (stream: 'stdout' | 'stderr' | 'exit', data: string) => {
    if (!wc.isDestroyed()) {
      wc.send(IPC.TERMINAL_OUTPUT, { sessionId: ownerId, stream, data })
    }
  }
  proc.stdout.on('data', (buf: Buffer) => push('stdout', buf.toString('utf8')))
  proc.stderr.on('data', (buf: Buffer) => push('stderr', buf.toString('utf8')))
  proc.on('exit', (code) => {
    sessions.delete(ownerId)
    push('exit', String(code ?? -1))
  })
  proc.on('error', (e) => {
    log.warn('终端进程错误', { error: e.message })
    push('stderr', `\n[进程错误] ${e.message}\n`)
  })

  sessions.set(ownerId, { proc, ownerId })
  return { ok: true, sessionId: ownerId }
}

/** 向终端 stdin 写入一行（渲染端已附换行）；deny 黑名单命令直接拦截 */
export function inputTerminal(ownerId: number, data: string): { ok: boolean; error?: string } {
  const s = sessions.get(ownerId)
  if (!s || !s.proc.stdin || s.proc.stdin.destroyed) {
    return { ok: false, error: '终端未运行' }
  }
  // Ctrl+C（\x03）直接透传，不做命令判定
  if (data !== '\x03') {
    const reason = classifyDenyOnly(data)
    if (reason) return { ok: false, error: `命令被安全策略拦截（${reason}）` }
  }
  try {
    s.proc.stdin.write(data)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `写入失败：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 终止终端 session（幂等） */
export function killTerminal(ownerId: number): void {
  const s = sessions.get(ownerId)
  if (!s) return
  sessions.delete(ownerId)
  try {
    s.proc.kill()
  } catch (e) {
    log.warn('终端进程终止失败', { error: e instanceof Error ? e.message : String(e) })
  }
}

/** 应用退出时统一清理（防子进程泄漏） */
export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
