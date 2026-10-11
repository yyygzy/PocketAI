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
//  - `%` 在引号内仍会被 cmd 展开成环境变量，无法转义 ⇒ 含 % 直接拒绝而不是悄悄改写

import { existsSync } from 'node:fs'
import path from 'node:path'

/** 命令名（不含目录）的分类 */
export type CommandKind = 'pe' | 'batch' | 'bare'

const PE_EXT_RE = /\.(exe|com)$/i
const BATCH_EXT_RE = /\.(cmd|bat)$/i

/** 拒绝字符：换行/回车会截断命令行；% 会被 cmd 展开（引号内也生效，无安全写法） */
const UNSAFE_RE = /[%\r\n]/

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
 */
export function findCommandInPath(
  command: string,
  pathDirs: string[],
  exists: (p: string) => boolean = existsSync
): 'exe' | 'batch' | 'unknown' {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/')) {
    // 带目录的命令按扩展名判；无扩展名时不猜（CreateProcess 只会补 .exe），原样 spawn 让 ENOENT 如实冒出来
    if (PE_EXT_RE.test(command)) return 'exe'
    if (BATCH_EXT_RE.test(command)) return 'batch'
    return 'unknown'
  }
  if (PE_EXT_RE.test(command)) return 'exe'
  if (BATCH_EXT_RE.test(command)) return 'batch'
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
      `${label}含 cmd.exe 无法安全转义的字符（% 或换行）：${JSON.stringify(value)}；请改用不含 % 的路径/参数`
    )
  }
}

/**
 * 构造交给 cmd.exe 的命令行（配合 spawn(line, { shell: true })）。
 * 命令名只在含空格时才加引号——npm 那类垫片加引号会碎，带空格的路径又必须加，二者不可兼得，
 * 这里按「不加会失败 vs 加了可能失败」取实测结论：bare 名不加，带空格的路径加。
 */
export function buildCmdShimLine(command: string, args: string[]): string {
  assertSafe('命令', command)
  const commandToken = /\s/.test(command) ? quoteToken(command) : command
  const rest = args.map((a) => {
    assertSafe('参数', a)
    return quoteToken(a)
  })
  return [commandToken, ...rest].join(' ')
}
