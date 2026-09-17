// 工具注册表（M3.3）
// 聚合 内置工具 + MCP 工具，按助手 toolPermissions 过滤；提供统一执行入口

import { BUILTIN_TOOLS } from './builtin'
import { getFsTools } from './fs-tools'
import { mcpManager } from '../mcp/manager'
import type { ToolSchema, ToolResult } from '../../shared/types'

class ToolRegistry {
  /** 所有内置工具（含按配置动态注册的 fs.* 工具） */
  private listBuiltinTools() {
    return [...BUILTIN_TOOLS, ...getFsTools()]
  }

  /** 列出所有内置工具的 schema */
  listBuiltin(): ToolSchema[] {
    return this.listBuiltinTools().map((t) => t.schema)
  }

  /** 列出所有已启动 MCP Server 的工具 schema */
  listMcp(): ToolSchema[] {
    const tools: ToolSchema[] = []
    for (const runtime of mcpManager.listRuntimes()) {
      if (runtime.status === 'running') {
        tools.push(...runtime.tools)
      }
    }
    return tools
  }

  /** 全部工具（内置 + MCP） */
  listAll(): ToolSchema[] {
    return [...this.listBuiltin(), ...this.listMcp()]
  }

  /**
   * 按助手权限过滤出可用工具。
   * toolPermissions 为空时返回空数组（保守策略，避免给普通助手加工具）。
   * 显式 "*" 表示允许全部。
   */
  filterByPermissions(permissions: string[] | null | undefined): ToolSchema[] {
    const all = this.listAll()
    if (!permissions || permissions.length === 0) return []
    if (permissions.includes('*')) return all
    const allowed = new Set(permissions)
    return all.filter((t) => allowed.has(t.id))
  }

  /** 把 ToolSchema 数组格式化为可注入 SystemPrompt 的 {{tools}} 文本 */
  formatForPrompt(tools: ToolSchema[]): string {
    if (tools.length === 0) return ''
    const lines = tools.map((t) => {
      const paramsJson = JSON.stringify(t.parameters)
      return `- ${t.name}: ${t.description} | 参数 schema: ${paramsJson} | id: ${t.id}`
    })
    return '可用工具（调用时返回 JSON 字符串）：\n' + lines.join('\n')
  }

  /** 执行单个工具调用 */
  async execute(toolName: string, argsJson: string, allowedToolIds: Set<string>): Promise<ToolResult> {
    // 先找 schema 校验是否在允许列表
    const all = this.listAll()
    const schema = all.find((t) => t.name === toolName)
    if (!schema) {
      return { toolCallId: '', name: toolName, content: `未知工具: ${toolName}`, isError: true }
    }
    if (!allowedToolIds.has('*') && !allowedToolIds.has(schema.id)) {
      return {
        toolCallId: '',
        name: toolName,
        content: `工具 ${toolName} 不在允许列表中（id=${schema.id}）`,
        isError: true
      }
    }

    let args: Record<string, unknown>
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    } catch {
      return { toolCallId: '', name: toolName, content: '参数 JSON 解析失败', isError: true }
    }

    try {
      if (schema.source === 'builtin') {
        const builtin = this.listBuiltinTools().find((t) => t.schema.id === schema.id)
        if (!builtin) {
          return { toolCallId: '', name: toolName, content: '内置工具未注册', isError: true }
        }
        const content = await builtin.execute(args)
        return { toolCallId: '', name: toolName, content }
      }
      // MCP 工具
      if (!schema.mcpServerId) {
        return { toolCallId: '', name: toolName, content: '缺少 mcpServerId', isError: true }
      }
      const raw = await mcpManager.callTool(schema.mcpServerId, schema.name, args)
      // MCP 返回 { content: [{ type, text }], isError? }，扁平化为字符串
      const content = stringifyMcpResult(raw)
      return { toolCallId: '', name: toolName, content, isError: Boolean((raw as any)?.isError) }
    } catch (e) {
      return { toolCallId: '', name: toolName, content: (e as Error).message, isError: true }
    }
  }
}

function stringifyMcpResult(raw: unknown): string {
  if (typeof raw === 'string') return raw
  const obj = raw as { content?: Array<{ type: string; text?: string }> }
  if (Array.isArray(obj?.content)) {
    return obj.content
      .map((c) => (c.type === 'text' && c.text ? c.text : JSON.stringify(c)))
      .join('\n')
  }
  try {
    return JSON.stringify(raw)
  } catch {
    return String(raw)
  }
}

export const toolRegistry = new ToolRegistry()
