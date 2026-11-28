// 用户手动终端服务（终端模块后端，非 Agent 工具）
//
// 与 shell_exec 工具的区别：
//  - shell_exec：Agent 驱动，一次性命令，需工作目录锚定 + confirm/allow 分类审批；
//  - 本服务：用户自己操作（等价于系统终端），长生命周期交互式 shell 子进程，
//    输出流式推送渲染端；安全上硬拒 deny 档 + 工作目录外路径（classifyTerminalCommand），
//    其余 confirm 档放行——用户本身就有能力打开系统终端（「用户即操作者」），
//    终端里没有审批 UI，confirm 弹窗无意义。取舍细节见 shell-tools 的 classifyTerminalCommand 注释。
//  - 每条命令（拦截的与已执行的）都写 security_events 留痕（SEC-16-04），锁屏时清空全部会话。
//
// 工作目录：旧的 `cwd: undefined` 注释写着「便携包根目录」，但代码并没有锚定到任何
// 应用目录——实际落点取决于进程从哪里启动。现在按 resolveTerminalCwd 的优先级显式选定。
//
// 生命周期：每个渲染窗口（webContentsId）最多一个 session；窗口销毁/模块 kill 时清理。
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { promisify } from 'node:util'
import { app, type WebContents } from 'electron'
import { IPC } from '../../shared/types'
import { errMsg } from '../error'
import { classifyTerminalCommand } from '../tools/shell-tools'
import { getWorkspaceDir } from '../tools/fs-tools'
import { capLogString } from '../security/log-redact'
import { securityEventRepo } from '../db/repositories/security-event.repo'
import { lockService } from '../lock/lock'
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
 * 每个候选都必须是确实存在、当前用户可写的目录（readonly 网络盘 / Program Files 下目录
 * 会让 shell 起来却无法重定向输出或建文件）；坏配置自动退档，全落空兜到进程 cwd。
 */
export function resolveTerminalCwd(requested?: string): string {
  const packaged = app?.isPackaged === true
  const appRootUsable = !packaged || !!process.env.PORTABLE_EXECUTABLE_DIR || !!process.env.APPIMAGE
  const candidates = [requested, getWorkspaceDir(), appRootUsable ? APP_ROOT : undefined, homedir()]
  for (const c of candidates) {
    if (!c) continue
    try {
      if (!statSync(c).isDirectory()) continue
      // W_OK 探测当前用户可写性：不创建文件、无副作用。root/管理员环境下
      // access(W_OK) 通常恒真，这档退化的后果只是仍落在该目录，不会误删数据。
      accessSync(c, constants.W_OK)
      return c
    } catch {
      // 不存在/不可读/不可写 ⇒ 退下一档
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
    // spawn() 返回对象后才注册 error 监听；$SHELL 不存在时 error(ENOENT) 后
    // Node 不保证再发 exit。不清 session 的话渲染端 running 永久为 true，
    // 之后每次输入都得到"终端未运行"，用户只能切模块重开。
    if (sessions.get(ownerId)?.proc === proc) sessions.delete(ownerId)
    push('exit', '-1')
  })

  sessions.set(ownerId, { proc, ownerId })
  return { ok: true, sessionId: ownerId, epoch, cwd }
}

/** 终端命令审计入库的单条上限（SEC-16-04）：先脱敏、再截断，防超长粘贴灌库 */
const MAX_AUDIT_CMD_CHARS = 500

/**
 * 终端命令写入 security_events 留痕（SEC-16-04）。
 *
 * 为什么留：终端 IPC 此前无审批也无审计，渲染层一旦被注入（XSS/供应链投毒）就等于完整 shell，
 * 出了事无从追溯。deny 拦截与已执行命令都记（kind 同为 terminal_command，拦截原因进 detail）。
 *
 * 脱敏与截断：命令文本可能携带内联凭据（curl -u user:pass 之类），走仓库既有的日志脱敏
 * 工具 log-redact 同口径处理——那边没有针对自由文本的值脱敏函数（redactSecretsInText 不存在），
 * 因此用其 capLogString 做「先截断」这一层；append 内部自带 fail-open（写失败只记日志不阻断），
 * 审计不可用不能把用户卡在终端外。
 *
 * kind 已由 securityEventRepo 的 SecurityEventKind 联合正式收编，无需断言绕过类型。
 */
export function auditTerminalCommand(ownerId: number, raw: string, blocked: string | null): void {
  const cmd = capLogString(String(raw ?? '').trim(), MAX_AUDIT_CMD_CHARS)
  securityEventRepo.append({
    kind: 'terminal_command',
    message: blocked ? `终端命令被安全策略拦截（${blocked}）：${cmd}` : `终端命令：${cmd}`,
    detail: { ownerId, blocked: blocked ?? null }
  })
}

/** 向终端 stdin 写入一行（渲染端已附换行）；deny 黑名单命令直接拦截 */
export function inputTerminal(ownerId: number, data: string): { ok: true } | { ok: false; error: string } {
  const s = sessions.get(ownerId)
  if (!s || !s.proc.stdin || s.proc.stdin.destroyed) {
    return { ok: false, error: '终端未运行' }
  }
  // Ctrl+C（\x03）直接透传，不做命令判定、不留痕（不是命令）
  if (data !== '\x03') {
    // 判定口径见 classifyTerminalCommand（shell-tools）：deny 档 + 工作目录外路径硬拒，
    // 其余 confirm 档放行（用户即操作者，终端里没有审批 UI）
    const reason = classifyTerminalCommand(data, getWorkspaceDir() || process.cwd())
    if (reason) {
      auditTerminalCommand(ownerId, data, reason)
      return { ok: false, error: `命令被安全策略拦截（${reason}）` }
    }
    auditTerminalCommand(ownerId, data, null)
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
  const pid = s.proc.pid
  if (platform() === 'win32' && typeof pid === 'number') {
    // proc.kill() 在 Windows 只杀直接子进程 cmd.exe；用户跑 npm run dev / ping -t
    // 后离开模块，孙进程仍占端口与 CPU。taskkill /T /F 连带整棵树，与
    // killAllTerminals「防子进程泄漏」的承诺对齐。异步执行、不阻塞 IPC 返回。
    void promisify(execFile)('taskkill', ['/PID', String(pid), '/T', '/F']).catch((e) => {
      log.warn('终端进程树终止失败（回退单进程 kill）', { error: errMsg(e) })
      try { s.proc.kill() } catch { /* 进程可能已退出 */ }
    })
    return
  }
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

// ── SEC-16-04：锁屏即清终端 ──
// 锁定（手动 / 自动超时 / 系统睡眠 / 应用隐藏触发）时终止全部终端会话，对齐 lock/ipc-gate 的
// fail-closed 口径：锁屏期间渲染层被注入也拿不到活 shell；锁屏期间终端 IPC 本身另有
// APP_LOCKED 网关兜住（ipcMain.handle 包装，既有机制，此处不重复）。
//
// 已知边界（审计报告已记）：「应用隐藏但未开启自动锁屏」时 lockService 不会进入 locked 态
// （onAppHidden 只在 autoLockTimeout>0 时排定时器），没有事件可订阅——要做到「隐藏即杀」
// 需要改 lock.ts 或窗口 hide 钩子，均在本次改动分区之外。
lockService.onStateChange((evt) => {
  if (evt.state !== 'locked') return
  const count = sessions.size
  if (count === 0) return
  killAllTerminals()
  log.info('锁屏终止终端会话', { count })
})
