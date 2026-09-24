// 工具注册表（M3.3）
// 聚合 内置工具 + MCP 工具，按助手 toolPermissions 过滤；提供统一执行入口

import { BUILTIN_TOOLS } from './builtin'
import type { ToolAgentContext, ToolClassification } from './builtin'
import { getFsTools } from './fs-tools'
import { getShellTools } from './shell-tools'
import { mcpManager } from '../mcp/manager'
import type { ToolSchema, ToolResult } from '../../shared/types'
import { errMsg } from '../error'

class ToolRegistry {
  /** 所有内置工具（含按配置动态注册的 fs.* / shell.exec 工具） */
  private listBuiltinTools() {
    return [...BUILTIN_TOOLS, ...getFsTools(), ...getShellTools()]
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

  /** 按工具名查找 schema（内置 + MCP），未找到返回 undefined */
  getSchema(toolName: string): ToolSchema | undefined {
    return this.listAll().find((t) => t.name === toolName)
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
      const params = t.parameters as {
        properties?: Record<string, { type?: unknown; description?: unknown }>
        required?: string[]
      } | null
      const paramList = params?.properties
        ? Object.entries(params.properties)
            .map(([k, v]) => {
              const required = params.required?.includes(k) ? '必填' : '可选'
              return `${k}(${v.type ? String(v.type) : 'any'}, ${required}): ${v.description ? String(v.description) : ''}`
            })
            .join('; ')
        : '无参数'
      return `- **${t.name}**: ${t.description}\n  参数: ${paramList}`
    })
    return '## 可用工具\n调用工具时返回 JSON 字符串结果。根据用户需求选择合适的工具：\n\n' + lines.join('\n\n')
  }

  /**
   * 判定一次工具调用应直接执行 / 需用户确认 / 硬拒。
   * 基线为 schema.permission；内置工具可通过 classify(args) 给出动态判定，
   * 最终取两者中更严格者（deny > confirm > allow）。
   */
  classify(toolName: string, argsJson: string, allowedToolIds: Set<string>): ToolClassification {
    const all = this.listAll()
    const schema = all.find((t) => t.name === toolName)
    if (!schema) return { decision: 'deny', reason: 'UNKNOWN_TOOL' }
    if (!allowedToolIds.has('*') && !allowedToolIds.has(schema.id)) {
      return { decision: 'deny', reason: 'TOOL_NOT_ALLOWED' }
    }

    let args: Record<string, unknown>
    try {
      args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    } catch {
      return { decision: 'deny', reason: 'BAD_ARGS' }
    }

    const baseline: ToolClassification =
      schema.permission === 'deny'
        ? { decision: 'deny', reason: 'TOOL_DENIED' }
        : schema.permission === 'confirm'
          ? { decision: 'confirm', reason: 'REQUIRES_CONFIRM' }
          : { decision: 'allow' }

    if (schema.source === 'builtin') {
      const builtin = this.listBuiltinTools().find((t) => t.schema.id === schema.id)
      if (builtin?.classify) {
        try {
          return stricterDecision(baseline, builtin.classify(args))
        } catch {
          return { decision: 'deny', reason: 'BAD_ARGS' }
        }
      }
    }
    return baseline
  }

  /** 执行单个工具调用（signal 透传给支持中止的长时工具，kbIds/agent 透传给 kb_search/todo_write） */
  async execute(
    toolName: string,
    argsJson: string,
    allowedToolIds: Set<string>,
    signal?: AbortSignal,
    kbIds?: string[],
    agent?: ToolAgentContext
  ): Promise<ToolResult> {
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
    } catch (e) {
      // 参数解析失败：返回丰富错误信息（原始参数+错误原因+修正引导），
      // 用 [BAD_ARGS] 前缀标记，engine 可据此追加修正引导消息。
      return {
        toolCallId: '',
        name: toolName,
        content: badArgsError(argsJson, errMsg(e)),
        isError: true
      }
    }

    try {
      if (schema.source === 'builtin') {
        const builtin = this.listBuiltinTools().find((t) => t.schema.id === schema.id)
        if (!builtin) {
          return { toolCallId: '', name: toolName, content: '内置工具未注册', isError: true }
        }
        const content = await builtin.execute(args, { signal, kbIds, agent })
        return { toolCallId: '', name: toolName, content }
      }
      // MCP 工具
      if (!schema.mcpServerId) {
        return { toolCallId: '', name: toolName, content: '缺少 mcpServerId', isError: true }
      }
      const raw = await mcpManager.callTool(schema.mcpServerId, schema.name, args)
      // MCP 返回 { content: [{ type, text }], isError? }，扁平化为字符串
      const content = stringifyMcpResult(raw)
      return { toolCallId: '', name: toolName, content, isError: mcpResultIsError(raw) }
    } catch (e) {
      return { toolCallId: '', name: toolName, content: errMsg(e), isError: true }
    }
  }
}

/**
 * BAD_ARGS 富文本错误（[BAD_ARGS] 前缀供引擎识别并追加修正引导）。
 * classify 解析失败（deny 路径）与 execute 解析失败共用，保证引导文案一致。
 */
export function badArgsError(argsJson: string, detail: string): string {
  const raw = argsJson ? argsJson.slice(0, 200) : '(空)'
  return `[BAD_ARGS] 参数 JSON 解析失败：${detail}\n原始参数：${raw}\n请修正 JSON 格式（确保引号、逗号、括号正确）后重新调用该工具，不要使用相同的错误参数。`
}

/** 取两个判定中更严格者（deny > confirm > allow），reason 随更严结果 */
export function stricterDecision(a: ToolClassification, b: ToolClassification): ToolClassification {
  const rank: Record<ToolClassification['decision'], number> = { allow: 0, confirm: 1, deny: 2 }
  return rank[b.decision] > rank[a.decision] ? b : a
}

/** 从 MCP tools/call 返回中提取 isError 标志（形状不保证，unknown 安全收窄） */
export function mcpResultIsError(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null || !('isError' in raw)) return false
  return Boolean((raw as { isError: unknown }).isError)
}

export function stringifyMcpResult(raw: unknown): string {
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
