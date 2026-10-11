// 运行时日志的着色口径：stderr ≠ 出错
//
// 官方 MCP server 习惯把正常启动横幅写到 stderr（例：`Knowledge Graph MCP Server running on stdio`），
// 之前一律标红让「启动成功」长得和报错一样。现在按 server 当前状态分级：
// 只有该 server 处于 error 态时 stderr 才是 danger，其余 stderr 走 warning。

import type { McpServerStatus } from '../../../../../shared/types'

export type LogTone = 'plain' | 'warn' | 'danger'

export function logLineTone(
  stream: 'stdout' | 'stderr',
  serverStatus: McpServerStatus | undefined
): LogTone {
  if (stream !== 'stderr') return 'plain'
  return serverStatus === 'error' ? 'danger' : 'warn'
}

export function logToneClass(tone: LogTone): string {
  if (tone === 'danger') return 'text-[var(--color-danger)]'
  if (tone === 'warn') return 'text-[var(--color-warning)]'
  return ''
}
