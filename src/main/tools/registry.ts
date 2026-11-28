// 工具注册表（M3.3）
// 聚合 内置工具 + MCP 工具，按助手 toolPermissions 过滤；提供统一执行入口

import { BUILTIN_TOOLS } from './builtin'
import type { BuiltinTool, ToolAgentContext, ToolClassification } from './builtin'
import { getFsTools } from './fs-tools'
import { getPatchTools } from './patch-tools'
import { getRunTestsTools } from './run-tests'
import { getSymbolTools } from './symbol-tools'
import { getMcpSymbolTools } from './mcp-symbol-tools'
import { getSkillTools } from './skill-tools'
import { getSkillScriptTools } from './skill-script-tools'
import { getShellTools, getShellPolicyInfo } from './shell-tools'
import { getArtifactTools } from './artifact-tools'
import { getProjectTools } from './project-tools'
import { mcpManager } from '../mcp/manager'
import type {
  ToolPolicyAssistantContext,
  ToolPolicyAssistantView,
  ToolPolicyEntry,
  ToolPolicySnapshot,
  ToolPolicyState,
  ToolSchema,
  ToolResult
} from '../../shared/types'
import { EXTERNAL_CONTENT_NOTICE } from '../../shared/external-content'
import type { ToolPolicyReasonCode } from '../../shared/tool-policy-reasons'
import { errMsg } from '../error'
import { assertToolExecutionAllowed } from '../agent/dry-run-scope'
import { recordPerf, logPerfDebug } from '../steward/perf-probe'

/** LLM 函数名合法形态（各 OpenAI 兼容端点普遍要求字母开头 + 字母数字下划线） */
const LLM_FUNCTION_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

/** 单次工具面重建达到该耗时才进「最近慢操作」缓冲；低于它只留 debug 日志 */
const REGISTRY_SLOW_MS = 5

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

/**
 * `'*'`（全授权声明）到底给什么：**只给内置工具**。
 *
 * 口径见 §4.4-⑧（2026-10-12 定）：内置 13 个工具继续默认授权（危险动作另有 classify 的
 * confirm/deny 分级），MCP 工具必须逐条 id 显式勾选——工具名与描述本就是外部内容（SEC-12），
 * 而它们是唯一"既最贵又最不可信"的一档。
 *
 * 为什么收口在注册表而不是只在 engine 展开一次：`filterByPermissions`（发给模型的工具面）、
 * `classify`（审批分档）、`execute`（执行前的 id 复核）是三处独立判定点，任何一处漏掉例外
 * 都会让 `'*'` 重新变成"MCP 也可用"；来源与工具定义同源，写在这里最不容易腐坏。
 * 同一条也解释了为什么不能靠改 `extensions/assistants/*.json` 下发：`upsertBuiltin` 对已存在的
 * 内置助手**故意不覆盖** `tool_permissions`（保留用户改动），数据文件只影响新装/重置。
 */
export function isToolAllowedBy(allowed: Set<string>, schema: ToolSchema): boolean {
  if (allowed.has(schema.id)) return true
  return allowed.has('*') && schema.source === 'builtin'
}

/** 内置工具的最小结构（策略屏与索引只用这三项，其余实现细节留在各工具模块） */
interface BuiltinToolLike {
  schema: ToolSchema
  classify?: (args: Record<string, unknown>) => ToolClassification
  policyReason?: ToolPolicyReasonCode
}

/** 一次工具面重建的产物：只读快照，帧内可被多次访问共享 */
interface ToolIndex {
  builtin: BuiltinTool[]
  builtinSchemas: ToolSchema[]
  mcpSchemas: ToolSchema[]
  tools: ToolSchema[]
  byName: Map<string, ToolSchema>
  builtinById: Map<string, BuiltinTool>
}

class ToolRegistry {
  /**
   * PERF-10：工具面帧缓存。
   *
   * 只在 Agent 一轮 run 内开启（`engine.run()` 入口 `beginFrame()` / 退出 `endFrame()`，
   * depth 计数支持委派嵌套）。帧内 N 条工具调用的 classify / getSchema / execute
   * 共用同一份只读快照，buildIndex 从 2N+2 次降为 1 次；帧外仍保持「每次访问重建」的
   * 旧语义，策略屏／面板试运行等旁路不会被一份长期快照卡住。
   *
   * 与 SEC-29 那次「单次构建 + 两张 Map」的边界：那次收口的是**一次构建内部**不重复取
   * 内置清单，本次收口的是**一轮 run 内**不重复构建；索引本身仍不含任何凭据明文
   * （MCP 的 env/headers 只在 manager 里，缓存里只有 ToolSchema），不写日志、不落盘。
   */
  private frameDepth = 0
  private frameIndex: ToolIndex | null = null
  /** 失效代数：每次 invalidate 递增，帧缓存带代数，避免异步回调里读到刚作废的快照 */
  private indexEpoch = 0
  private frameIndexEpoch = -1

  /** 进入一帧（可嵌套；只有最外层进入时才清掉上一帧可能残留的快照） */
  beginFrame(): void {
    if (this.frameDepth++ === 0) {
      this.frameIndex = null
      this.frameIndexEpoch = -1
    }
  }

  /** 退出一帧；最外层退出即丢弃快照——工作目录／shell 策略等变更最多影响当前帧 */
  endFrame(): void {
    if (this.frameDepth === 0) return
    if (--this.frameDepth === 0) {
      this.frameIndex = null
      this.frameIndexEpoch = -1
    }
  }

  /** 显式失效：MCP 服务器增删改、启停、工具权限变化后调用；帧内下一次访问立即重建 */
  invalidate(): void {
    this.indexEpoch++
    this.frameIndex = null
    this.frameIndexEpoch = -1
  }
  /** 所有内置工具（含按配置动态注册的 fs.* / shell.exec 工具） */
  private listBuiltinTools() {
    return [
      ...BUILTIN_TOOLS,
      ...getFsTools(),
      ...getPatchTools(),
      ...getRunTestsTools(),
      ...getSymbolTools(),
      ...getMcpSymbolTools(),
      ...getShellTools(),
      ...getSkillTools(),
      ...getSkillScriptTools(),
      ...getArtifactTools(),
      ...getProjectTools()
    ]
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

  /**
   * 取当前工具面索引：帧内复用同一份快照，帧外每次重建（见帧缓存字段的注释）。
   * 失效后 indexEpoch 变化 / 帧结束清引用，都不会把旧快照再交出去。
   */
  private buildIndex(): ToolIndex {
    if (this.frameDepth > 0 && this.frameIndex && this.frameIndexEpoch === this.indexEpoch) {
      return this.frameIndex
    }
    const index = this.computeIndex()
    if (this.frameDepth > 0) {
      this.frameIndex = index
      this.frameIndexEpoch = this.indexEpoch
    }
    return index
  }

  /**
   * 一次构建出「工具面 + 两张索引」（SEC-29 零风险项的成本收口，本文件不改其等价性）。
   *
   * 为什么收口成一处：listAll / getSchema / classify / execute / 策略屏此前各自重建，
   * 而 listAll 里 `listBuiltin()` 还被调了两遍（一次拼前置、一次传给改名器），
   * 每遍都要读工作目录与终端策略（SQLite 点查）、MCP 段还要逐行解密 env/headers（SEC-11）。
   * 这里只算一次，并把 name→schema、id→内置实现两张表一并建好，
   * 使原来的线性 find（classify/execute 里还各多一次内置重扫）变成 O(1)。
   */
  private computeIndex(): ToolIndex {
    const startedAt = performance.now()
    const builtin = this.listBuiltinTools()
    const builtinSchemas = builtin.map((t) => t.schema)
    const mcpSchemas = ensureUniqueToolNames(builtinSchemas, this.listMcp())
    // 顺序与历史 listAll 一致：内置在前、MCP 在后；同名先出现者优先（等价于旧的 find 语义）
    const tools = [...builtinSchemas, ...mcpSchemas]
    const byName = new Map<string, ToolSchema>()
    for (const t of tools) if (!byName.has(t.name)) byName.set(t.name, t)
    const builtinById = new Map(builtin.map((t) => [t.schema.id, t] as const))
    const ms = performance.now() - startedAt
    const detail = `tools=${tools.length} mcp=${mcpSchemas.length}`
    // 慢操作进环形缓冲（数据健康面板可见），快操作只留 debug 日志，避免稀释「最近慢操作」
    if (ms >= REGISTRY_SLOW_MS) recordPerf('tools.registry', ms, detail)
    else logPerfDebug('tools.registry', ms, detail)
    return { builtin, builtinSchemas, mcpSchemas, tools, byName, builtinById }
  }

  /** 全部工具（内置 + MCP，MCP 名称已保证全局唯一） */
  listAll(): ToolSchema[] {
    return this.buildIndex().tools
  }

  /**
   * 策略屏的只读快照：判定值只从这里出去。
   * - 内置工具：schema.permission 基线＋同处定义的 policyReason；动态分类器只标 `dynamic`；
   * - 终端：开关/策略/原因码来自 `getShellPolicyInfo()`（同一份规则表，见 shell-tools.ts:550）；
   * - MCP：`'*'` 不覆盖，状态固定 `needs-explicit`（与 isToolAllowedBy 同一口径）。
   * 渲染端不得另写阈值或工具名单——测试按函数身份钉，而不是数规则条数。
   */
  policySnapshot(assistant?: ToolPolicyAssistantContext): ToolPolicySnapshot {
    const shell = getShellPolicyInfo()
    const index = this.buildIndex()
    const entries: ToolPolicyEntry[] = []
    for (const tool of index.builtin) {
      // 终端即使被停用也要出现在屏上，单独由下面的 shell 段补齐
      if (tool.schema.id === 'shell.exec') continue
      entries.push({
        id: tool.schema.id,
        name: tool.schema.name,
        source: 'builtin',
        permission: tool.schema.permission ?? 'auto',
        state: tool.schema.permission === 'deny' ? 'denied' : 'available',
        dynamic: Boolean(tool.classify),
        reasons: tool.policyReason ? [tool.policyReason] : [],
        ...(tool.schema.costTier ? { costTier: tool.schema.costTier } : {})
      })
    }
    entries.push({
      id: 'shell.exec',
      name: 'shell_exec',
      source: 'builtin',
      permission: 'auto',
      state: shell.enabled ? 'available' : 'disabled',
      dynamic: true,
      reasons: []
    })
    const mcpSchemas = index.mcpSchemas
    for (const schema of mcpSchemas) {
      const state: ToolPolicyState =
        schema.permission === 'deny' ? 'denied' : 'needs-explicit'
      entries.push({
        id: schema.id,
        name: schema.name,
        source: 'mcp',
        mcpServerId: schema.mcpServerId,
        permission: schema.permission ?? 'auto',
        state,
        dynamic: false,
        reasons: []
      })
    }
    const mcpStoppedServers = mcpManager.listRuntimes().filter((r) => r.status !== 'running').length
    return {
      tools: entries,
      shell,
      mcpStoppedServers,
      assistant: assistant ? this.effectiveView(assistant, shell, mcpSchemas, index.builtin) : undefined
    }
  }

  /**
   * 「当前助手实际生效工具面」。
   *
   * 判定只走两条既有机关，不在这里另写规则：
   *  · 授权：`isToolAllowedBy`（`'*'` 只覆盖内置，MCP 必须逐条 id）；
   *  · 空数组语义：由 IPC 层调用 `resolveAgentToolPermissions` 解析后传进来（[] 不等于 ['*']）。
   * 这里只负责把「未授权 / 内在 deny / 被策略停用 / MCP 需逐条」翻成一档可渲染的状态。
   */
  private effectiveView(
    assistant: ToolPolicyAssistantContext,
    shell: ReturnType<typeof getShellPolicyInfo>,
    mcpSchemas: ToolSchema[],
    builtin: BuiltinToolLike[]
  ): ToolPolicyAssistantView {
    const allowed = new Set(assistant.permissions)
    const tools: ToolPolicyEntry[] = []
    for (const tool of builtin) {
      if (tool.schema.id === 'shell.exec') continue
      const granted = isToolAllowedBy(allowed, tool.schema)
      const state: ToolPolicyState =
        tool.schema.permission === 'deny'
          ? 'denied'
          : granted
            ? 'available'
            : 'not-granted'
      tools.push({
        id: tool.schema.id,
        name: tool.schema.name,
        source: 'builtin',
        permission: tool.schema.permission ?? 'auto',
        state,
        dynamic: Boolean(tool.classify),
        reasons: tool.policyReason ? [tool.policyReason] : [],
        granted,
        ...(tool.schema.costTier ? { costTier: tool.schema.costTier } : {})
      })
    }
    const shellSchema = builtin.find((t) => t.schema.id === 'shell.exec')?.schema
    const shellGranted = shellSchema ? isToolAllowedBy(allowed, shellSchema) : false
    tools.push({
      id: 'shell.exec',
      name: 'shell_exec',
      source: 'builtin',
      permission: shellSchema?.permission ?? 'auto',
      state: !shell.enabled ? 'disabled' : shellGranted ? 'available' : 'not-granted',
      dynamic: true,
      reasons: [],
      granted: shellGranted
    })
    for (const schema of mcpSchemas) {
      const granted = isToolAllowedBy(allowed, schema)
      tools.push({
        id: schema.id,
        name: schema.name,
        source: 'mcp',
        mcpServerId: schema.mcpServerId,
        permission: schema.permission ?? 'auto',
        state: schema.permission === 'deny' ? 'denied' : granted ? 'available' : 'needs-explicit',
        dynamic: false,
        reasons: [],
        granted
      })
    }
    const loadSkillSchema = builtin.find((t) => t.schema.id === 'skill.load')?.schema
    return {
      ...assistant,
      loadSkillAvailable: loadSkillSchema ? isToolAllowedBy(allowed, loadSkillSchema) : false,
      tools
    }
  }

  /** 按工具名查找 schema（内置 + MCP），未找到返回 undefined */
  getSchema(toolName: string): ToolSchema | undefined {
    return this.buildIndex().byName.get(toolName)
  }

  /**
   * 按助手权限过滤出可用工具。
   * toolPermissions 为空时返回空数组（保守策略，避免给普通助手加工具）。
   * 显式 "*" 表示允许全部**内置**工具（MCP 工具需逐条 id 授权，见 isToolAllowedBy）。
   */
  filterByPermissions(permissions: string[] | null | undefined): ToolSchema[] {
    if (!permissions || permissions.length === 0) return []
    const all = this.buildIndex().tools
    // 判定只留 isToolAllowedBy 一处。这里曾为 '*' 单开分支（`return builtin`），
    // 于是 `['*', 'mcp:srv:tool']` 里逐条点名的 MCP 工具也被丢掉——而提示语恰恰叫用户去勾选。
    const allowed = new Set(permissions)
    return all.filter((t) => isToolAllowedBy(allowed, t))
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
    return '## 可用工具\n调用工具时返回 JSON 字符串结果。根据用户需求选择合适的工具。\n' +
      // SEC-12：MCP 工具的名字与描述由 server 自报，属于外部内容——只能当数据看，不能当指令执行
      // 与技能正文共用同一句声明（src/shared/external-content.ts），避免同一类内容两套口径
      `**注意**：${EXTERNAL_CONTENT_NOTICE}\n\n` +
      lines.join('\n\n')
  }

  /**
   * 判定一次工具调用应直接执行 / 需用户确认 / 硬拒。
   * 基线为 schema.permission；内置工具可通过 classify(args) 给出动态判定，
   * 最终取两者中更严格者（deny > confirm > allow）。
   */
  classify(toolName: string, argsJson: string, allowedToolIds: Set<string>): ToolClassification {
    const index = this.buildIndex()
    const schema = index.byName.get(toolName)
    if (!schema) return { decision: 'deny', reason: 'UNKNOWN_TOOL' }
    if (!isToolAllowedBy(allowedToolIds, schema)) {
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
          ? {
              decision: 'confirm',
              reason: 'REQUIRES_CONFIRM',
              // MCP 破坏性/开放世界工具：即使被勾过「总是允许」也必须逐次询问
              ...(schema.forceConfirm ? { risk: 'danger' as const, forceConfirm: true } : {})
            }
          : { decision: 'allow' }

    if (schema.source === 'builtin') {
      const builtin = index.builtinById.get(schema.id)
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

  /**
   * 执行单个工具调用（signal 透传给支持中止的长时工具，kbIds/agent 透传给 kb_search/todo_write）。
   * 注意：本方法**不经过审批链**——引擎在调用前已自行跑 `classify` + `createApproval`，
   * 而 MCP 面板的「手动试运行」等旁路会绕过审批直接落到这里，因此这些调用不会进
   * approval_events（P0-2c-1 已明确不纳入）。这是已知风险，暂不改结构。
   */
  async execute(
    toolName: string,
    argsJson: string,
    allowedToolIds: Set<string>,
    signal?: AbortSignal,
    kbIds?: string[],
    skillIds?: string[],
    agent?: ToolAgentContext
  ): Promise<ToolResult> {
    // P0-5 dry-run 回放：执行收口第一道闸。作用域外是 no-op；
    // 作用域内抛错并计入 `blockedAttempts`，绝不落到下面的工具实现里。
    assertToolExecutionAllowed(toolName)

    const index = this.buildIndex()
    const schema = index.byName.get(toolName)
    if (!schema) {
      return { toolCallId: '', name: toolName, content: `未知工具: ${toolName}`, isError: true }
    }
    if (!isToolAllowedBy(allowedToolIds, schema)) {
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
        const builtin = index.builtinById.get(schema.id)
        if (!builtin) {
          return { toolCallId: '', name: toolName, content: '内置工具未注册', isError: true }
        }
        const content = await builtin.execute(args, { signal, kbIds, skillIds, agent })
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
  const winner = rank[b.decision] > rank[a.decision] ? b : a
  // 两边都是 confirm 时，任一侧要求强制确认都要保留，否则基线/动态判定会互相抹掉风险档
  if (winner.decision === 'confirm' && (a.forceConfirm || b.forceConfirm)) {
    return { ...winner, risk: 'danger', forceConfirm: true }
  }
  return winner
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

/**
 * PERF-10 失效路径①：MCP 运行态变化。
 * 启动/停止/崩溃自动重启/对账摘除都会改 `runtime.tools`，其中自动重启与 WebDAV 合并后的
 * reconcile 不经过 MCP IPC handler，只能从 manager 的状态事件统一收口；事件里不带 env/headers
 * 明文，回调只递增代数、不缓存凭据。守卫 `typeof` 是为了兼容只加载本模块纯函数的测试桩。
 */
if (typeof mcpManager.onStatus === 'function') {
  mcpManager.onStatus(() => toolRegistry.invalidate())
}
