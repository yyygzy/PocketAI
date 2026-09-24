// 受限终端工具（shell_exec）
//
// 安全边界：
//  1. 仅在「已设置 Agent 工作目录 + 策略开关开启」时动态注册；
//  2. cwd 锚定工作目录，子目录参数复用 fs 工具同款穿越守卫；
//  3. 命令经分类器三档判定：allow 直跑 / confirm 需用户审批 / deny 黑名单硬拒；
//  4. 超时杀整个进程树（Win taskkill /T，POSIX 进程组）；输出按 32KB 截断。
// 本工具不是 OS 沙箱：批准的命令以应用自身权限运行。
import { spawn } from 'node:child_process'
import type { BuiltinTool } from './builtin'
import { getWorkspaceDir, resolveWorkspacePath } from './fs-tools'
import { getShellConfig } from './shell-config'

export type CommandDecision = 'allow' | 'confirm' | 'deny'

export interface CommandClassification {
  decision: CommandDecision
  /** 稳定 reason code，渲染端映射 i18n */
  reason?: string
}

const DEFAULT_TIMEOUT_MS = 30_000
const MIN_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 120_000
const MAX_OUTPUT_CHARS = 32 * 1024 // stdout/stderr 各自上限（字符）
// 采集阶段按字节截断的上限：UTF-8 每字符最多 4 字节，留足余量后在解码侧按字符二次截断
const MAX_OUTPUT_BYTES = MAX_OUTPUT_CHARS * 4

/**
 * 解码子进程输出。
 * 中文 Windows 无控制台（管道重定向）时，cmd 内建命令与老程序固定输出 GBK(936)，
 * chcp 65001 对重定向句柄无效；现代程序（node/git/Python UTF-8 模式）输出 UTF-8。
 * 策略：严格 UTF-8 试解，失败则回退 GBK。截断可能落在多字节字符中间，试解前
 * 允许砍掉末尾最多 3 个残字节；GBK 双字节流几乎不可能是合法 UTF-8，判定可靠。
 */
function decodeOutput(buf: Buffer): string {
  const len = buf.length
  for (let cut = 0; cut <= 3 && cut <= len; cut++) {
    const candidate = cut === 0 ? buf : buf.subarray(0, len - cut)
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(candidate)
    } catch {
      // 末尾残字节或整体非 UTF-8：继续砍 / 最终回退 GBK
    }
  }
  return new TextDecoder('gbk').decode(buf)
}

/** 按字节上限累积单个流的输出 */
class OutputCollector {
  private chunks: Buffer[] = []
  private bytes = 0
  private truncated = false

  push(chunk: Buffer): void {
    if (this.bytes >= MAX_OUTPUT_BYTES) {
      this.truncated = true
      return
    }
    let b = chunk
    if (this.bytes + b.length > MAX_OUTPUT_BYTES) {
      b = b.subarray(0, MAX_OUTPUT_BYTES - this.bytes)
      this.truncated = true
    }
    this.chunks.push(b)
    this.bytes += b.length
  }

  /** 解码 + 按字符截断 */
  finish(): { text: string; truncated: boolean } {
    let text = decodeOutput(Buffer.concat(this.chunks))
    if (text.length > MAX_OUTPUT_CHARS) {
      text = text.slice(0, MAX_OUTPUT_CHARS)
      this.truncated = true
    }
    return { text, truncated: this.truncated }
  }
}

/** 复合命令分隔符（&& / || / | / ; / Win 的 & / POSIX 换行）。朴素拆分，不做引号感知——
 *  误拆分只会造成「多一次确认」（安全方向），而 deny 级检查同时对整条命令生效。 */
const SEGMENT_SPLIT_RE = /&&|\|\||[|&;\r\n]/

// ---------- deny（黑名单：毁灭性/不可逆系统命令，永不执行） ----------
// 每条 [正则, reason]，对整条命令（大小写不敏感）匹配
const DENY_RULES: Array<[RegExp, string]> = [
  // format 必须带盘符才算（避免误杀 "npm run format"）
  [/\bformat(?:\.com)?\b[^\n]*\b[a-z]:/i, 'BLOCKED_FORMAT'],
  [/\bdiskpart\b/i, 'BLOCKED_DISKPART'],
  [/\bmkfs(?:\.\w+)?\b/i, 'BLOCKED_MKFS'],
  [/\b(?:shutdown|reboot|halt|poweroff|stop-computer|restart-computer)\b/i, 'BLOCKED_SHUTDOWN'],
  [/\bbcdedit\b/i, 'BLOCKED_BOOTCFG'],
  [/\bcipher\b[^|&;\r\n]*\/w\b/i, 'BLOCKED_CIPHER_WIPE'],
  // 删除注册表关键蜂巢
  [
    /\breg(?:\.exe)?\b[^|&;\r\n]*\bdelete\b[^|&;\r\n]*\b(?:HKLM|HKCU|HKEY_LOCAL_MACHINE|HKEY_CURRENT_USER)\\(?:SAM|SECURITY|SYSTEM)(?:\\|\b)/i,
    'BLOCKED_REG_HIVE'
  ],
  // 递归删除 Windows 系统目录：盘符路径（del /f /s c:\windows）、
  // WSL 挂载点（rm -rf /mnt/c/Windows）、环境变量展开（del %SystemRoot%）
  [
    /\b(?:rm|del|erase|rd|rmdir)\b[^|&;\r\n]*(?:\b[a-z]:[\\/]windows(?:[\\/]|\b)|\/mnt\/[a-z][\\/]windows(?:[\\/]|\b)|%(?:SYSTEMROOT|WINDIR)%(?:[\\/]|\b))/i,
    'BLOCKED_SYSTEM_DELETE'
  ],
  // POSIX fork 炸弹  :(){ :|:& };:
  [/:\s*\(\s*\)\s*\{[^}]*:\s*\|[^}]*\}\s*;/, 'BLOCKED_FORKBOMB'],
  // Windows %0|%0 自启动炸弹
  [/%0\s*\|%0/, 'BLOCKED_FORKBOMB']
]

// 裸根递归删除（rm -rf / 、rm -rf C:\ 、del/rd C:\ 根或根通配 c:\*）
const ROOT_DELETE_RE = [
  // POSIX: rm 带 r/f 且目标为裸 / 或 /*
  /\brm\b[^|&;\r\n]*-[^|&;\r\n]*[rf][^|&;\r\n]*\s\/(?:\*?\s*$|\*)/i,
  // 任意删除工具指向盘符根（C:\ 后直接结束、空白或通配符）
  /\b(?:rm|del|erase|rd|rmdir)\b[^|&;\r\n]*\b[a-z]:[\\/](?:\s|$|\*)/i
]

// ---------- confirm（危险特征：需用户审批） ----------
// 对拆分后的每个片段匹配；命中即确认
const CONFIRM_RULES: Array<[RegExp, string]> = [
  [/\b(?:rm|del|erase|rd|rmdir|remove-item)\b/i, 'DANGEROUS_DELETE'],
  // 移动 / 强制复制 / 镜像复制 / 输出重定向写文件
  [/\b(?:move|mv|move-item)\b/i, 'DANGEROUS_OVERWRITE'],
  [/\bcp\b[^|&;\r\n]*-f\b/i, 'DANGEROUS_OVERWRITE'],
  [/\b(?:copy|xcopy)\b[^|&;\r\n]*\/y\b/i, 'DANGEROUS_OVERWRITE'],
  // robocopy 默认覆盖、/MIR 还会镜像删除
  [/\brobocopy\b/i, 'DANGEROUS_OVERWRITE'],
  [/>+?/, 'DANGEROUS_OVERWRITE'],
  [/\b(?:taskkill|kill|pkill|stop-process)\b/i, 'DANGEROUS_KILL'],
  [/\b(?:chmod|chown|attrib|icacls|takeown)\b/i, 'DANGEROUS_PERMISSION'],
  // 账号管理
  [/\bnet\b[^|&;\r\n]*\buser\b/i, 'DANGEROUS_ACCOUNT'],
  [/\b(?:useradd|usermod|userdel|passwd|new-localuser|add-user)\b/i, 'DANGEROUS_ACCOUNT'],
  // 写入/导入注册表
  [/\breg(?:\.exe)?\b[^|&;\r\n]*\b(?:add|import)\b/i, 'DANGEROUS_REGISTRY'],
  [/\bgit\b[^|&;\r\n]*\bpush\b/i, 'DANGEROUS_PUBLISH'],
  // 下载即执行（curl|sh/bash/python/node、iex(iwr ...)、Invoke-Expression）
  [
    /(?:curl|wget|iwr|invoke-webrequest)[^|;&\r\n]*\|[^|;&\r\n]*(?:sh|bash|cmd|powershell|pwsh|python(?:3)?|node|deno|perl)/i,
    'DANGEROUS_PIPE_EXEC'
  ],
  [/\b(?:iex|invoke-expression)\b/i, 'DANGEROUS_PIPE_EXEC'],
  // PowerShell 编码命令
  [/-(?:enc|encodedcommand)\b/i, 'DANGEROUS_ENCODED'],
  // 提权动词
  [/\b(?:sudo|runas)\b/i, 'DANGEROUS_PRIVILEGE'],
  // 目录穿越：cd .. 、../ 、..\ 、a/../b、sub\..\..（前导允许 / 与 \；
  // git 的 A..B 区间语法中 .. 紧邻字母/波浪线，不会命中）
  [/(?:^|[\s=:'"([\\/])\.\.(?:[\\/]|\s|$)/, 'DANGEROUS_TRAVERSAL'],
  // 环境变量家目录（工作目录之外）
  [/(?:~[\\/]|\$HOME\b|%(?:USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR)%)/i, 'DANGEROUS_OUTSIDE']
]

/** 提取命令中出现的盘符路径（C:\... / C:/...）；盘符前须为起始/分隔符，
 *  避免把 URL 里的 "http://"（末字母 p 恰好像盘符）误判为路径 */
const WIN_ABS_PATH_RE = /(?:^|[\s"'`=(,;])([a-zA-Z]:[\\/][^\s"'`|&;<>]*)/g

/**
 * 命令分类（纯函数，导出供走查/测试）。
 * 复合命令任一片段命中更高风险则整体取最严：deny > confirm > allow。
 */
export function classifyCommand(command: string, workspaceAbs: string): CommandClassification {
  const raw = String(command ?? '')
  if (!raw.trim()) return { decision: 'deny', reason: 'BAD_ARGS' }

  // Windows cmd 中 ^ 是转义符（"format c^:" 实际等同 "format c:"），
  // 判定前归一化去除，防止用脱字符绕过黑名单；POSIX 下 ^ 有语义，不处理。
  const cmd = process.platform === 'win32' ? raw.replace(/\^/g, '') : raw

  // 1) 黑名单：对整条命令生效（不依赖拆分，防引号绕过）
  for (const [re, reason] of DENY_RULES) {
    if (re.test(cmd)) return { decision: 'deny', reason }
  }
  for (const re of ROOT_DELETE_RE) {
    if (re.test(cmd)) return { decision: 'deny', reason: 'BLOCKED_ROOT_DELETE' }
  }

  // 2) 工作目录之外的绝对路径（盘符路径；POSIX 绝对路径误伤面大，仅对明显系统目录确认）
  const wsWin = workspaceAbs.toLowerCase().replace(/[\\/]+$/, '').replace(/\//g, '\\')
  for (const m of cmd.matchAll(WIN_ABS_PATH_RE)) {
    const p = m[1]!
    const normWin = p.replace(/[\\/]+$/, '').toLowerCase().replace(/\//g, '\\')
    if (normWin !== wsWin && !normWin.startsWith(wsWin + '\\')) {
      return { decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' }
    }
  }
  // POSIX 风格 /etc、/usr、/bin、/sbin、/System、私有目录等
  if (/(^|[\s="'`(])\/(?:etc|usr|bin|sbin|System|private|var\/root)(?:[\\/]|\b)/.test(cmd)) {
    return { decision: 'confirm', reason: 'DANGEROUS_OUTSIDE' }
  }

  // 3) 危险特征：整条命令（覆盖管道跨段模式，如 curl|sh）+ 每个片段各判一遍
  const segments = cmd.split(SEGMENT_SPLIT_RE)
  for (const [re, reason] of CONFIRM_RULES) {
    if (re.test(cmd)) return { decision: 'confirm', reason }
    for (const seg of segments) {
      if (re.test(seg)) return { decision: 'confirm', reason }
    }
  }

  return { decision: 'allow' }
}

// ---------- 执行 ----------
interface ShellExecArgs {
  command?: unknown
  timeoutMs?: unknown
  cwd?: unknown
}

interface ShellExecResult {
  command: string
  cwd: string
  exitCode: number | null
  signal: string | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  timedOut: boolean
  durationMs: number
}

/** 杀掉整个进程树（Windows 用系统自带 taskkill，POSIX 杀进程组） */
function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      })
      killer.on('error', () => { /* taskkill 失败退回单进程杀 */ })
      killer.unref()
    } catch {
      // taskkill 不可用时退回单进程杀
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL') // 同进程组
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        /* 已退出 */
      }
    }
  }
}

/** 执行单条 shell 命令（异步，不阻塞主进程）。
 *  abortSignal 触发时立即杀整个进程树（用户点「停止」时不留孤儿进程）。 */
function runCommand(
  command: string,
  cwdAbs: string,
  timeoutMs: number,
  abortSignal?: AbortSignal
): Promise<ShellExecResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32'
    const file = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh'
    const args = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
    // Python 输出到管道时默认按区域编码（中文系统为 GBK）写字节，强制 UTF-8。
    // 其余 Windows 程序（cmd 内建命令、老程序）仍会输出 GBK，由 decodeOutput 回退解码。
    const childEnv: NodeJS.ProcessEnv = isWin
      ? { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
      : process.env

    // 收集原始字节（编码在结束时统一判定，见 decodeOutput）
    const stdoutBuf = new OutputCollector()
    const stderrBuf = new OutputCollector()
    let timedOut = false
    let settled = false
    const startedAt = Date.now()

    const child = spawn(file, args, {
      cwd: cwdAbs,
      windowsHide: true, // 不弹控制台窗口
      detached: !isWin, // POSIX 独立进程组，便于整组杀掉
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    // 超时定时器独立于外部 Promise 竞态：即使外层 30s race 放弃本 Promise，
    // 到点仍会杀进程树，避免孤儿长驻进程。
    const timer = setTimeout(() => {
      timedOut = true
      killProcessTree(child.pid!)
    }, timeoutMs)
    timer.unref?.()

    // Agent 中止 → 立即杀进程树（本 Promise 即使已被外层 race 放弃，清理仍生效）
    const onAbort = () => {
      killProcessTree(child.pid!)
    }
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (abortSignal?.aborted) killProcessTree(child.pid!)

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      abortSignal?.removeEventListener('abort', onAbort)
      const out = stdoutBuf.finish()
      const err = stderrBuf.finish()
      resolve({
        command,
        cwd: cwdAbs,
        exitCode,
        signal: signal ?? null,
        stdout: out.text,
        stderr: err.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut,
        durationMs: Date.now() - startedAt
      })
    }

    // 不设 encoding：保留原始 Buffer，交给 decodeOutput 判编码（GBK/UTF-8）
    child.stdout?.on('data', (chunk: Buffer) => stdoutBuf.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderrBuf.push(chunk))
    child.on('error', (e) => {
      // spawn 失败（shell 不存在等）：错误信息放 stderr（ASCII + 中文消息统一 UTF-8 编码）
      stderrBuf.push(Buffer.from(`\n[spawn 失败] ${e.message}`, 'utf-8'))
      finish(null, null)
    })
    child.on('close', (code, signal) => finish(code, signal))
  })
}

/** shell_exec 的动态判定：开关 / 黑名单 / 策略 / 命令内容 */
function classifyShellArgs(args: Record<string, unknown>): CommandClassification {
  const config = getShellConfig()
  if (!config.enabled) return { decision: 'deny', reason: 'SHELL_DISABLED' }

  const command = String((args as ShellExecArgs)?.command ?? '').trim()
  if (!command) return { decision: 'deny', reason: 'BAD_ARGS' }

  // 黑名单在任何策略下都硬拒（deny 最高优先，先于策略分支）
  const verdict = classifyCommand(command, getWorkspaceDir() || process.cwd())
  if (verdict.decision === 'deny') return verdict

  // 逐条确认：非黑名单命令也一律弹窗，但保留 classifyCommand 的具体危险原因，
  // 避免审批展示层再次调用 classifyCommand 造成重复分类。
  if (config.policy === 'confirm') {
    return { decision: 'confirm', reason: verdict.reason ?? 'REQUIRES_CONFIRM' }
  }
  // 仅危险确认：沿用分类器结果（confirm/allow）
  return verdict
}

const shellExecTool: BuiltinTool = {
  schema: {
    id: 'shell.exec',
    name: 'shell_exec',
    description:
      '在 Agent 工作目录内执行一条 shell 命令（Windows 用 cmd，macOS/Linux 用 sh）。' +
      '每次调用是独立进程，不支持交互式/TTY 程序（如 vim、python REPL）。' +
      '参数：command (string, 命令全文), timeoutMs (number, 可选 10000-120000，默认 30000), ' +
      'cwd (string, 可选，相对工作目录的子目录，默认根)。' +
      '返回 JSON：exitCode/stdout/stderr/timedOut/durationMs 等。删除、格式化等危险命令会被拒绝或要求用户确认。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，如 "git status" 或 "python build.py"' },
        timeoutMs: { type: 'number', description: '超时毫秒，10000-120000，默认 30000' },
        cwd: { type: 'string', description: '相对工作目录的子目录，默认 "."（根）' }
      },
      required: ['command'],
      additionalProperties: false
    },
    source: 'builtin',
    // 基线 auto：实际判定全部交给 classify（策略关闭→deny，逐条确认→confirm）
    permission: 'auto',
    timeoutMs: 120_000 // shell 命令可能耗时较长（如编译、下载），给 120s
  },

  /** 工具级判定（与 registry 的 schema 基线取更严） */
  classify(args: Record<string, unknown>): CommandClassification {
    return classifyShellArgs(args)
  },

  async execute(
    args: Record<string, unknown>,
    ctx?: import('./builtin').ToolExecuteContext
  ): Promise<string> {
    const a = args as ShellExecArgs
    const command = String(a.command ?? '').trim()
    if (!command) throw new Error('command 不能为空')

    // 执行前再次以当前策略分类（防止「判定后、执行前」配置被改松）
    const classification = classifyShellArgs(args)
    if (classification.decision === 'deny') {
      throw new Error(`命令被安全策略拒绝（${classification.reason ?? 'BLOCKED'}）`)
    }

    let timeoutMs = Number(a.timeoutMs)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TIMEOUT_MS
    timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutMs))

    const cwdAbs = resolveWorkspacePath(String(a.cwd ?? '.'))
    const result = await runCommand(command, cwdAbs, timeoutMs, ctx?.signal)
    return JSON.stringify(result)
  }
}

/** 已设置工作目录且开关开启时才注册（否则模型看不到该工具） */
export function getShellTools(): BuiltinTool[] {
  if (!getWorkspaceDir()) return []
  if (!getShellConfig().enabled) return []
  return [shellExecTool]
}
