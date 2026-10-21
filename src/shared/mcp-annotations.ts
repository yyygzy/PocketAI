// MCP 工具注解的展示串（§236）：渲染层不 import 主进程，所以这段纯函数放共享层。
import type { McpToolAnnotations } from './types'

/** 把 Server 自报的注解拼成一串短标签（只列它为真的那几项；title 单列不混进来） */
export function describeMcpAnnotations(a: McpToolAnnotations): string {
  const parts: string[] = []
  if (a.readOnlyHint === true) parts.push('readOnly')
  if (a.destructiveHint === true) parts.push('destructive')
  if (a.idempotentHint === true) parts.push('idempotent')
  if (a.openWorldHint === true) parts.push('openWorld')
  return parts.length > 0 ? parts.join(', ') : 'title'
}
