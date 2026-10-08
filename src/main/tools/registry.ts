// 工具注册表（M3.3）
// 聚合 内置工具 + MCP 工具，按助手 toolPermissions 过滤；提供统一执行入口

import { BUILTIN_TOOLS } from './builtin'
import type { ToolAgentContext, ToolClassification } from './builtin'
import { getFsTools } from './fs-tools'
import { getShellTools } from './shell-tools'
import { mcpManager } from '../mcp/manager'
import type { ToolSchema, ToolResult } from '../../shared/types'
import { errMsg } from '../error'

/** LLM 函数名合法形态（各 OpenAI 兼容端点普遍要求字母开头 + 字母数字下划线） */
const LLM_FUNCTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** 把任意工具名清洗成合法函数字符名（非法字符转下划线，缺首字母补 m） */
export function sanitizeFunctionName(raw: string): string {
  const cleaned = String(raw ?? '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64)
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `m_${cleaned}`.slice(0, 64)
}

/** 消歧前缀：取 serverId（UUID）去横线后前 8 位，确定性且不受 Server 改名影响 */
function mcpNameScope(serverId: string): string {
  const hex = String(serverId ?? '').replace(/[^0-9a-fA-F]/g, '')
  return `m_${(hex.slice(0, 8) || 'srv').toLowerCase()}`
}

/** 在同名集合里取一个未占用名字（冲突时追加 _2/_3…） */
function uniqueName(base: string, taken: Set<string>): string {
  let candidate = base
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${base}_${n}`
    n++
  }
  return candidate
}

/**
 * 保证 MCP 工具的可调用名在「内置 + 已注册 MCP」范围内全局唯一，并符合 LLM 函数字符名约束。
 *
 * 为什么必须改名（SEC-4 根因）：授权按 id 过滤、而分类与执行按 name 查找（协议只给 name），
 * 一旦 MCP server 工具与内置工具同名（如 fs_write），模型看到的是 Server 的描述，
 * 实际命中的却是内置工具——等于用「未授权的工具」干活；两个 Server 同名工具也会互相遮蔽。
 * 改名后的原工具名保留在 remoteName，调用 Server 时仍用原名，id 不变故助手授权不受影响。
 */
export function ensureUniqueToolNames(
  builtinTools: ToolSchema[],
  mcpTools: ToolSchema[]
): ToolSchema[] {
  const taken = new Set<string>(builtinTools.map((t) => t.name))
  const out: ToolSchema[] = []
  for (const t of mcpTools) {
    const nameValid = LLM_FUNCTION_NAME_RE.test(t.name)
    const aliasNeeded = !nameValid || taken.has(t.name)
    if (!aliasNeeded) {
      taken.add(t.name)
      out.push(t)
      continue
    }
    const base = `${mcpNameScope(t.mcpServerId ?? t.id)}_${sanitizeFunctionName(t.name)}`
    const aliased = uniqueName(base, taken)
    taken.add(aliased)
    out.push({ ...t, name: aliased, remoteName: t.name })
  }
  return out
}

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

  /** 全部工具（内置 + MCP，MCP 名称已保证全局唯一） */
  listAll(): ToolSchema[] {
    return [...this.listBuiltin(), ...ensureUniqueToolNames(this.listBuiltin(), this.listMcp())]
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
      // 改名后的工具对 Server 仍用原名（name 是给 LLM 看的唯一可调用名）
      const raw = await mcpManager.callTool(
        schema.mcpServerId,
        schema.remoteName ?? schema.name,
        args
      )
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

/**
 * MCP 工具结果扁平化后的最大字符数。
 * 引擎只会把压缩到 2000 字符的副本喂给 LLM，但完整结果会写 SQLite 并经 IPC 广播渲染层；
 * 被投毒/失控的 MCP server 可返回超大结果撑爆 DB/IPC/渲染进程，故在协议边界先封顶。
 */
export const MAX_MCP_RESULT_CHARS = 256 * 1024
/** content 数组最大项数（每项至少 1 字符，配合总字符上限双保险） */
const MAX_MCP_RESULT_ITEMS = 100

function appendTruncatedNotice(out: string, max: number): string {
  return `${out}\n…[工具输出过大，已截断至 ${max} 字符]`
}

export function stringifyMcpResult(raw: unknown): string {
  if (typeof raw === 'string') {
    return raw.length <= MAX_MCP_RESULT_CHARS
      ? raw
      : appendTruncatedNotice(raw.slice(0, MAX_MCP_RESULT_CHARS), MAX_MCP_RESULT_CHARS)
  }
  const obj = raw as { content?: unknown } | null
  if (Array.isArray(obj?.content)) {
    const items = (obj as { content: unknown[] }).content
    const parts: string[] = []
    let total = 0
    let charLimited = false
    let droppedItems = 0
    for (let i = 0; i < items.length; i++) {
      if (parts.length >= MAX_MCP_RESULT_ITEMS) {
        droppedItems = items.length - i
        break
      }
      const c = items[i] as { type?: unknown; text?: unknown }
      // 与旧逻辑一致：非 text 项或空 text 走 JSON 序列化
      const piece =
        c && typeof c === 'object' && c.type === 'text' && c.text
          ? String(c.text)
          : safeJsonStringify(c)
      if (total + piece.length > MAX_MCP_RESULT_CHARS) {
        parts.push(piece.slice(0, MAX_MCP_RESULT_CHARS - total))
        total = MAX_MCP_RESULT_CHARS
        charLimited = true
        droppedItems = items.length - i - 1
        break
      }
      parts.push(piece)
      total += piece.length
    }
    let out = parts.join('\n')
    if (charLimited) out = appendTruncatedNotice(out, MAX_MCP_RESULT_CHARS)
    if (droppedItems > 0) {
      out += `\n…[工具输出项数过多，已丢弃尾部 ${droppedItems} 项（上限 ${MAX_MCP_RESULT_ITEMS} 项）]`
    }
    return out
  }
  const json = safeJsonStringify(raw)
  return json.length <= MAX_MCP_RESULT_CHARS
    ? json
    : appendTruncatedNotice(json.slice(0, MAX_MCP_RESULT_CHARS), MAX_MCP_RESULT_CHARS)
}

/** JSON.stringify 失败（BigInt/循环引用等）降级为 String() */
function safeJsonStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export const toolRegistry = new ToolRegistry()
