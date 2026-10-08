// MCP 启动命令的可读呈现（导入预览与启动前确认共用）
//
// 为什么收成一处（SEC-2）：两处若各拼一次，措辞差异会让用户在预览里看到的
// 与点启动时确认的不是同一件事，确认就退化成形式。
//
// 呈现原则：这是安全确认用的预览，**参数边界比排版干净更重要**——
// 含空白的参数加引号呈现，否则 `python -c "rm -rf /"` 会展平成看不出边界的 `-c rm -rf /`。
import type { McpTransport } from '../../../../../shared/types'

interface LaunchShape {
  transport?: McpTransport
  command?: string | null
  args?: string[]
  url?: string | null
  env?: Record<string, string>
  headers?: Record<string, string>
}

/** stdio 拼成命令行（含参数）；http 显示目标 URL */
export function formatMcpLaunch(rec: LaunchShape | null | undefined): string {
  if (!rec) return ''
  if (rec.transport === 'http') return rec.url?.trim() ?? ''
  const cmd = rec.command?.trim() ?? ''
  const args = (rec.args ?? [])
    .map((a) => String(a ?? ''))
    .filter((a) => a.length > 0)
    .map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))
  return [cmd, ...args].join(' ').trim()
}

/** 会随启动传入的凭据键名（只显示键名，不显示值）；无凭据返回空串 */
export function mcpSecretKeyHint(rec: LaunchShape | null | undefined): string {
  const keys = [
    ...Object.keys(rec?.env ?? {}).map((k) => `env:${k}`),
    ...Object.keys(rec?.headers ?? {}).map((k) => `header:${k}`)
  ]
  return keys.join(', ')
}
