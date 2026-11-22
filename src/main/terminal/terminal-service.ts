// 用户手动终端服务（终端模块后端，非 Agent 工具）
//
// 与 shell_exec 工具的区别：
//  - shell_exec：Agent 驱动，一次性命令，需工作目录锚定 + confirm/allow 分类审批；
//  - 本服务：用户自己操作（等价于系统终端），长生命周期交互式 shell 子进程，
//    输出流式推送渲染端；安全上仅保留 deny 黑名单硬拒（classifyDenyOnly），
//    因为用户本身就有能力打开系统终端，confirm 审批对「用户本人」无意义。
//
// 工作目录：旧的 `cwd: undefined` 注释写着「便携包根目录」，但代码并没有锚定到任何
// 应用目录——实际落点取决于进程从哪里启动。现在按 resolveTerminalCwd 的优先级显式选定。
//
// 生命周期：每个渲染窗口（webContentsId）最多一个 session；窗口销毁/模块 kill 时清理。
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { app, type WebContents } from 'electron'
import { IPC } from '../../shared/types'
import { classifyDenyOnly } from '../tools/shell-tools'
import { getWorkspaceDir } from '../tools/fs-tools'
import { APP_ROOT } from '../portable'
import { createLogger } from '../logger'

const log = createLogger('terminal')

interface TerminalSession {
  proc: ChildProcess
  /** 窗口 id（输出推送目标） */
  ownerId: number
}

const sessions = new Map<number, TerminalSession>()

/**
 * 每一轮 shell 的轮次号（§320）。
 *
 * 为什么需要：同一窗口重开终端（切语言、卸载再挂、dev 的 StrictMode 双跑）时 `ownerId` 恒定不变，
 * 而上一轮那台 shell 被 `killTerminal` 之后的 `'exit'` 是异步的——它和新一轮的监听器注册在同一段
 * 窗口里赛跑。迟到的那一帧一旦被新一轮收下，渲染端会把 `running` 误置成 false（输入框从此失灵），
 * 屏上还多出一个退出码。轮次号让每一帧自己说清"我是哪一轮写的"。
 */
let lastEpoch = 0

/** 当前平台的交互式 shell 启动命令 */
function shellCommand(): { cmd: string; args: string[] } {
  if (process.platform === 'win32') return { cmd: 'cmd.exe', args: [] }
  return { cmd: process.env.SHELL || '/bin/sh', args: ['-i'] }
}

/**
 * 终端工作目录的优先级：
 *  ① 本轮显式传入（终端页将来切换目录时用）
 *  ② 用户在设置里选定的 Agent 工作目录（与 shell_exec / fs.* 同一份）
 *  ③ 便携版 / 开发态 / AppImage ⇒ APP_ROOT（exe 旁边或项目根，可写）
 *  ④ 安装版 ⇒ 用户主目录（APP_ROOT 通常是 Program Files，普通用户不可写，也不该被终端污染）
 * 每个候选都必须是确实存在的目录，坏配置不会把 shell 起在一个奇怪的位置；全落空兜到进程 cwd。
 */
export function resolveTerminalCwd(requested?: string): string {
  const packaged = app?.isPackaged === true
  const appRootUsable = !packaged || !!process.env.PORTABLE_EXECUTABLE_DIR || !!process.env.APPIMAGE
  const candidates = [requested, getWorkspaceDir(), appRootUsable ? APP_ROOT : undefined, homedir()]
  for (const c of candidates) {
    if (!c) continue
    try {
      if (statSync(c).isDirectory()) return c
    } catch {
      // 不存在/不可读 ⇒ 退下一档
    }
  }
  return process.cwd()
}

/** 启动终端 session（同窗口重复调用先杀旧的） */
export function startTerminal(wc: WebContents, requestedCwd?: string): { ok: true; sessionId: number; epoch: number; cwd?: string } | { ok: false; error: string } {
  const ownerId = wc.id
  killTerminal(ownerId)
  const epoch = ++lastEpoch
  const { cmd, args } = shellCommand()
  let proc: ChildProcess
  let cwd: string
  try {
    cwd = resolveTerminalCwd(requestedCwd)
    proc = spawn(cmd, args, {
      cwd,
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
      wc.send(IPC.TERMINAL_OUTPUT, { sessionId: ownerId, epoch, stream, data })
    }
  }
  proc.stdout.on('data', (buf: Buffer) => push('stdout', buf.toString('utf8')))
  proc.stderr.on('data', (buf: Buffer) => push('stderr', buf.toString('utf8')))
  proc.on('exit', (code) => {
    // §306：只有当 sessions[ownerId] 仍指向**本 proc** 才删。startTerminal 重开同窗口时
    // 会先 killTerminal(旧)＋set(新)，而旧 proc 的 'exit' 是异步、通常在新 session 就位之后才到；
    // 无身份守卫就会把刚登记的新 session 连带删掉 ⇒ 新 shell 进程成孤儿、killAllTerminals 收不到（退出仍留一个活 shell）。
    if (sessions.get(ownerId)?.proc === proc) sessions.delete(ownerId)
    push('exit', String(code ?? -1))
  })
  proc.on('error', (e) => {
    log.warn('终端进程错误', { error: e.message })
    push('stderr', `\n[进程错误] ${e.message}\n`)
  })

  sessions.set(ownerId, { proc, ownerId })
  return { ok: true, sessionId: ownerId, epoch, cwd }
}

/** 向终端 stdin 写入一行（渲染端已附换行）；deny 黑名单命令直接拦截 */
export function inputTerminal(ownerId: number, data: string): { ok: true } | { ok: false; error: string } {
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
