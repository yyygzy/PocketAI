// Windows 批处理垫片（npm/npx/yarn…）的启动适配
//
// 为什么需要这一层：npm 在 Windows 上装的 `npx` 是 `npx.cmd` 批处理，不是 PE 可执行文件。
// CreateProcess 只会自动补 `.exe`，所以 spawn('npx') 直接 ENOENT；显式写 `npx.cmd` 又撞上
// Node 20.12+/22 起的安全限制（非 shell 起 .bat/.cmd 一律 EINVAL）。墨匣的 stdio 传输层
// 两个条件都不满足 ⇒ 所有 `command: 'npx'` 的 MCP server 在 Windows 上从未起得来。
//
// 唯一可靠的走法是交一条我们自己构造的命令行给 cmd.exe（shell:true）。实测口径（本机 Node 22）：
//  - 参数一律加双引号、内嵌 " 翻倍 → 子进程拿到精确 argv：["a b", "x&y", 'p"q']，& | ^ 全部失效
//  - **命令名不能加引号**：`"npx" "--version"` 会让 npx.cmd 把参数当位置参数（node loader 报错）
//  - 安全性不靠「命令名恰好没空格」，而是先把 cmd 全部元字符拒掉（M7）：
//    `%&|<>()^"` 与 CR/LF 在引号内外都可能改变解析结果，一律拒绝，不做猜测式转义
//
// 导入外部 MCP 配置包时同样调用 `assertCommandLineSafe` 早拒，避免恶意 command 落库后等待启动。

import { existsSync } from 'node:fs'
import path from 'node:path'

/** 命令名（不含目录）的分类 */
export type CommandKind = 'pe' | 'batch' | 'bare'

const PE_EXT_RE = /\.(exe|com)$/i
const BATCH_EXT_RE = /\.(cmd|bat)$/i

/**
 * cmd.exe 无法安全转义的全部元字符（M7）：
 * - `%`：在引号内仍会展开环境变量；
 * - `& | < > ( ) ^ "`：改变命令行分割/重定向/引用语义；
 * - CR/LF：截断命令行追加第二条命令。
 */
const UNSAFE_RE = /[%&|<>()^"\r\n]/

export function classifyCommandName(command: string): CommandKind {
  const base = command.split(/[\\/]/).pop() ?? command
  if (PE_EXT_RE.test(base)) return 'pe'
  if (BATCH_EXT_RE.test(base)) return 'batch'
  return 'bare'
}

/**
 * 在 PATH 目录里找这个命令到底是什么：
 * 先找 `<name>.exe`（CreateProcess 自己就能补上，不需要垫片），再找 `<name>.cmd/.bat`。
 * 两者都没有返回 'unknown' —— 保持原样去 spawn，让 ENOENT 如实冒出来，不做猜测式兜底。
 * 调用方显式写了扩展名时必须真的找得到该文件，否则不把它当 batch（M7）。
 */
export function findCommandInPath(
  command: string,
  pathDirs: string[],
  exists: (p: string) => boolean = existsSync
): 'exe' | 'batch' | 'unknown' {
  const hasDir = path.isAbsolute(command) || command.includes(path.sep) || command.includes('/')
  if (PE_EXT_RE.test(command)) {
    return hasDir ? (exists(command) ? 'exe' : 'unknown') : 'exe'
  }
  if (BATCH_EXT_RE.test(command)) {
    if (!hasDir) {
      // 裸 npx.cmd：在 PATH 里确认同名文件真实存在，避免凭后缀就把不存在的文件当垫片
      for (const dir of pathDirs) {
        if (dir && exists(path.join(dir, command))) return 'batch'
      }
      return 'unknown'
    }
    return exists(command) ? 'batch' : 'unknown'
  }
  if (hasDir) {
    // 带目录且无扩展名时不猜（CreateProcess 只会补 .exe），原样 spawn 让 ENOENT 如实冒出来
    return 'unknown'
  }
  for (const dir of pathDirs) {
    if (!dir) continue
    if (exists(path.join(dir, `${command}.exe`))) return 'exe'
  }
  for (const dir of pathDirs) {
    if (!dir) continue
    if (exists(path.join(dir, `${command}.cmd`)) || exists(path.join(dir, `${command}.bat`))) return 'batch'
  }
  return 'unknown'
}

/** 该命令是否需要经 cmd.exe 起（仅 win32；非 Windows 恒 false） */
export function needsCmdShim(
  command: string,
  platform: NodeJS.Platform = process.platform,
  envPath: string | undefined = process.env.PATH
): boolean {
  if (platform !== 'win32') return false
  const dirs = (envPath ?? '').split(path.delimiter)
  return findCommandInPath(command, dirs) === 'batch'
}

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`
}

function assertSafe(label: string, value: string): void {
  if (UNSAFE_RE.test(value)) {
    throw new Error(
      `${label}含 cmd.exe 无法安全转义的字符（% & | < > ( ) ^ " 或换行）：${JSON.stringify(value)}；请改用不含这些字符的路径/参数`
    )
  }
}

/** 导入配置/构造命令行前统一校验：任何 cmd 元字符都拒绝，不做降级放行 */
export function assertCommandLineSafe(command: string, args: readonly string[]): void {
  assertSafe('命令', command)
  for (const arg of args) assertSafe('参数', arg)
}

/**
 * 构造交给 cmd.exe 的命令行（配合 spawn(line, { shell: true })）。
 * 命令名只在含空格时才加引号——npm 那类垫片加引号会碎，带空格的路径又必须加，二者不可兼得；
 * 无条件先过 assertCommandLineSafe，剩下的「裸命令名」只可能由安全字符组成，不会被 cmd 追加指令。
 */
export function buildCmdShimLine(command: string, args: string[]): string {
  assertCommandLineSafe(command, args)
  const commandToken = /\s/.test(command) ? quoteToken(command) : command
  const rest = args.map(quoteToken)
  return [commandToken, ...rest].join(' ')
}
