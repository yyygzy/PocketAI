// 能力中心：状态派生 / 分组 / 搜索排序的纯函数（P1-1 第一段）。
//
// 两条硬口径，改这里之前先读：
// 1) MCP 的「已授权 N 个助手」**只能**来自主进程 policySnapshot()（ToolPolicyEntry[]）。
//    渲染端不写任何 permission 名单或阈值——工具是否可调用、`'*'` 覆盖到哪，都由 registry 一处判定。
// 2) MCP **没有**「启用开关」：`manager.start()` 从不读旧的 `mcp_servers.enabled`（该列已在迁移
//    v58 删除），运行与否只由 runtime.status 决定。把状态画成「已启用」是一张假状态脸。
import type {
  AssistantRecord,
  McpServerRecord,
  McpServerRuntime,
  SkillRecord,
  ToolPolicyEntry,
  ToolPolicySnapshot
} from '../../../../shared/types'
import type { McpTemplate } from '../../../../shared/mcp-templates'

/** 在线 registry 条目（与 preload.fetchSkillIndex 的返回形状一致） */
export interface OnlineSkill {
  id: string
  name: string
  description?: string
  icon?: string
  url: string
}

/** 技能状态是闭合三档：停用 / 启用但没绑任何助手 / 已绑定（N 个助手）。 */
export type SkillCapabilityState = 'disabled' | 'enabled-unbound' | 'bound'

/** MCP 运行状态直接取运行时（stopped/starting/error/running），与 manager 推送的四档同源。 */
export type McpCapabilityState = 'stopped' | 'starting' | 'error' | 'running'

export interface InstalledSkillItem {
  kind: 'installedSkill'
  skill: SkillRecord
  /** 引用这条技能的助手数（按助手 id 去重） */
  boundAssistants: number
  state: SkillCapabilityState
}

export interface OnlineSkillItem {
  kind: 'onlineSkill'
  skill: OnlineSkill
}

export interface McpServerItem {
  kind: 'mcpServer'
  server: McpServerRecord
  state: McpCapabilityState
  /** 运行中 Server 暴露的工具名（搜索用；未运行时为空） */
  toolNames: string[]
  /**
   * 至少授权一条该 Server 工具的助手数（来自 policySnapshot 的 assistant 视角）。
   * null＝不知道：Server 未运行时它的工具根本不在快照里，数出来的 0 会把「没暴露」说成「没授权」。
   */
  authorizedAssistants: number | null
}

export interface McpTemplateItem {
  kind: 'mcpTemplate'
  template: McpTemplate
  /** 已翻译的模板描述（搜索用；翻译在渲染层做，本模块保持纯数据） */
  description: string
  /** 已存在同名 Server＝这个模板已经配置过 */
  configured: boolean
}

export type CapabilityItem =
  | InstalledSkillItem
  | OnlineSkillItem
  | McpServerItem
  | McpTemplateItem

export const CAPABILITY_GROUP_ORDER = [
  'installedSkills',
  'onlineSkills',
  'mcpServers',
  'mcpTemplates'
] as const
export type CapabilityGroupKey = (typeof CAPABILITY_GROUP_ORDER)[number]

/** 按类型分组，四组永不混排 */
export interface CapabilityGroups {
  installedSkills: InstalledSkillItem[]
  onlineSkills: OnlineSkillItem[]
  mcpServers: McpServerItem[]
  mcpTemplates: McpTemplateItem[]
}

export interface CapabilityInput {
  skills: readonly SkillRecord[]
  assistants: readonly AssistantRecord[]
  onlineSkills: readonly OnlineSkill[]
  servers: readonly McpServerRecord[]
  runtimes: readonly McpServerRuntime[]
  templates: readonly McpTemplate[]
  /** 模板 id → 已翻译描述（缺省按空串参与搜索） */
  templateDescriptions: Readonly<Record<string, string>>
  /** 每个助手的 policySnapshot；null＝还没读到/读失败（授权数一律按「不知道」处理） */
  snapshots: readonly ToolPolicySnapshot[] | null
}

/** 一条技能被几个助手引用（与运行时 buildSkillsContext 的口径一致：只认 assistant.skillIds） */
export function countSkillBoundAssistants(
  assistants: readonly AssistantRecord[],
  skillId: string
): number {
  return new Set(
    assistants.filter((a) => (a.skillIds ?? []).includes(skillId)).map((a) => a.id)
  ).size
}

export function deriveSkillCapabilityState(
  skill: Pick<SkillRecord, 'enabled'>,
  boundAssistants: number
): SkillCapabilityState {
  if (!skill.enabled) return 'disabled'
  return boundAssistants > 0 ? 'bound' : 'enabled-unbound'
}

/**
 * 从快照里挑出属于某个 Server 的 MCP 工具。
 * 优先用主进程新填的 `mcpServerId`；旧形状（只有 `mcp:<serverId>:<tool>` 的 id）走前缀兜底，
 * 这样能力中心不必依赖某一版主进程就先能读。
 */
export function mcpEntriesOfServer(
  tools: readonly ToolPolicyEntry[],
  serverId: string
): ToolPolicyEntry[] {
  return tools.filter((entry) => {
    if (entry.source !== 'mcp') return false
    if (entry.mcpServerId) return entry.mcpServerId === serverId
    return entry.id.startsWith(`mcp:${serverId}:`)
  })
}

/**
 * 「已授权 N 个助手」：每个助手的快照里，只要有一条该 Server 的工具 `granted === true` 就算。
 * 快照必须带 assistant 视角（getToolPolicy(assistantId) 的返回）；注册表全量视角没有 granted，不计。
 */
export function countAuthorizedAssistants(
  serverId: string,
  snapshots: readonly ToolPolicySnapshot[]
): number {
  let count = 0
  for (const snap of snapshots) {
    const view = snap.assistant
    if (!view) continue
    if (mcpEntriesOfServer(view.tools, serverId).some((entry) => entry.granted === true)) {
      count++
    }
  }
  return count
}

/** 只读 runtime.status。MCP 没有「启用开关」——理由见文件头。 */
export function deriveMcpCapabilityState(
  runtime: Pick<McpServerRuntime, 'status'> | undefined
): McpCapabilityState {
  switch (runtime?.status) {
    case 'running':
      return 'running'
    case 'starting':
      return 'starting'
    case 'error':
      return 'error'
    default:
      return 'stopped'
  }
}

/** 搜索排序用的字段。toolNames 只对运行中的 MCP Server 有值。 */
export interface ItemSearchFields {
  name: string
  description?: string | null
  toolNames?: readonly string[]
}

/** 0=名称全匹配 1=名称前缀 2=名称子串 3=辅助字段命中；null=不匹配 */
export type MatchTier = 0 | 1 | 2 | 3

/**
 * 分档：名称全匹配 > 前缀 > 子串 > 描述命中。
 * MCP 工具名不在原定的四档里（它是「运行中服务器可搜工具名」的附加能力），归到最低的辅助档，
 * 与描述命中同档——同档再按「已就绪优先」。不做安装量/评分排序。
 */
export function matchTier(query: string, fields: ItemSearchFields): MatchTier | null {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const name = fields.name.toLowerCase()
  if (name === q) return 0
  if (name.startsWith(q)) return 1
  if (name.includes(q)) return 2
  if ((fields.description ?? '').toLowerCase().includes(q)) return 3
  if ((fields.toolNames ?? []).some((n) => n.toLowerCase().includes(q))) return 3
  return null
}

export function searchFieldsOf(item: CapabilityItem): ItemSearchFields {
  switch (item.kind) {
    case 'installedSkill':
      return { name: item.skill.name, description: item.skill.description }
    case 'onlineSkill':
      return { name: item.skill.name, description: item.skill.description }
    case 'mcpServer':
      return { name: item.server.name, toolNames: item.toolNames }
    case 'mcpTemplate':
      return { name: item.template.draft.name, description: item.description }
  }
}

/** 已就绪＝真的会在对话里生效：技能已启用且至少绑了一个助手；MCP Server 正在运行；模板已配置。 */
export function isItemReady(item: CapabilityItem): boolean {
  switch (item.kind) {
    case 'installedSkill':
      return item.skill.enabled && item.boundAssistants > 0
    case 'onlineSkill':
      return false
    case 'mcpServer':
      return item.state === 'running'
    case 'mcpTemplate':
      return item.configured
  }
}

/**
 * 组内过滤＋排序：命中档位升序，同档「已就绪」优先，再按原始顺序（稳定）。
 * query 为空时不做过滤，只把已就绪的排前面（其余保持原顺序）。
 */
export function rankAndFilterItems(
  items: readonly CapabilityItem[],
  query: string
): CapabilityItem[] {
  const scored = items.map((item, index) => ({
    item,
    index,
    tier: matchTier(query, searchFieldsOf(item))
  }))
  const kept = query.trim() ? scored.filter((s) => s.tier !== null) : scored
  kept.sort((a, b) => {
    const tierDiff = (a.tier ?? 0) - (b.tier ?? 0)
    if (tierDiff !== 0) return tierDiff
    const readyDiff = Number(isItemReady(b.item)) - Number(isItemReady(a.item))
    if (readyDiff !== 0) return readyDiff
    return a.index - b.index
  })
  return kept.map((s) => s.item)
}

/** 聚合四类并做状态派生。onlineSkills 由调用方按「用户主动加载」的结果传入，本函数不联网。 */
export function buildCapabilityGroups(input: CapabilityInput): CapabilityGroups {
  const installedSkills: InstalledSkillItem[] = input.skills.map((skill) => {
    const boundAssistants = countSkillBoundAssistants(input.assistants, skill.id)
    return {
      kind: 'installedSkill',
      skill,
      boundAssistants,
      state: deriveSkillCapabilityState(skill, boundAssistants)
    }
  })

  const onlineSkills: OnlineSkillItem[] = input.onlineSkills.map((skill) => ({
    kind: 'onlineSkill',
    skill
  }))

  const runtimesById = new Map(input.runtimes.map((runtime) => [runtime.id, runtime]))
  const mcpServers: McpServerItem[] = input.servers.map((server) => {
    const runtime = runtimesById.get(server.id)
    const state = deriveMcpCapabilityState(runtime)
    return {
      kind: 'mcpServer',
      server,
      state,
      toolNames: state === 'running' ? (runtime?.tools ?? []).map((tool) => tool.name) : [],
      // 未运行 ⇒ 工具不在任何快照列里 ⇒ 授权数不可知（null），不是 0。
      authorizedAssistants:
        state === 'running' && input.snapshots
          ? countAuthorizedAssistants(server.id, input.snapshots)
          : null
    }
  })

  const mcpTemplates: McpTemplateItem[] = input.templates.map((template) => ({
    kind: 'mcpTemplate',
    template,
    description: input.templateDescriptions[template.id] ?? '',
    configured: input.servers.some((server) => server.name === template.draft.name)
  }))

  return { installedSkills, onlineSkills, mcpServers, mcpTemplates }
}

/** 对四组各自应用搜索与排序（不跨组混排） */
export function filterCapabilityGroups(
  groups: CapabilityGroups,
  query: string
): CapabilityGroups {
  return {
    installedSkills: rankAndFilterItems(groups.installedSkills, query) as InstalledSkillItem[],
    onlineSkills: rankAndFilterItems(groups.onlineSkills, query) as OnlineSkillItem[],
    mcpServers: rankAndFilterItems(groups.mcpServers, query) as McpServerItem[],
    mcpTemplates: rankAndFilterItems(groups.mcpTemplates, query) as McpTemplateItem[]
  }
}
