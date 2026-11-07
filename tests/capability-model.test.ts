// P1-1 第一段：能力中心状态派生 / 分组 / 搜索排序纯函数。
// fixture 固定，覆盖技能四种状态与 MCP 四种运行状态；MCP 的授权数只从 policySnapshot 形状来，
// 这里用合成快照钉住「渲染端不另写规则」。
import { describe, it, expect } from 'vitest'
import {
  buildCapabilityGroups,
  countAuthorizedAssistants,
  countSkillBoundAssistants,
  deriveMcpCapabilityState,
  deriveSkillCapabilityState,
  filterCapabilityGroups,
  isItemReady,
  matchTier,
  mcpEntriesOfServer,
  rankAndFilterItems,
  type CapabilityInput,
  type CapabilityItem,
  type McpServerItem
} from '../src/renderer/src/modules/skills/capability-model'
import type {
  AssistantRecord,
  McpServerRecord,
  McpServerRuntime,
  SkillRecord,
  ToolPolicyEntry,
  ToolPolicySnapshot
} from '../src/shared/types'
import { listMcpTemplates } from '../src/shared/mcp-templates'

const skill = (over: Partial<SkillRecord> & Pick<SkillRecord, 'id' | 'name'>): SkillRecord => ({
  description: '',
  icon: '🧩',
  content: '',
  resident: true,
  enabled: true,
  isBuiltin: false,
  createdAt: 1,
  ...over
})

const assistant = (
  over: Partial<AssistantRecord> & Pick<AssistantRecord, 'id' | 'name'>
): AssistantRecord => ({
  description: '',
  avatar: '',
  systemPrompt: '',
  defaultProviderId: null,
  defaultModel: null,
  defaultParams: null,
  toolPermissions: [],
  skillIds: [],
  knowledgeBaseIds: [],
  welcomeMessage: '',
  isBuiltin: false,
  isPinned: false,
  createdAt: 1,
  ...over
})

const server = (
  over: Partial<McpServerRecord> & Pick<McpServerRecord, 'id' | 'name'>
): McpServerRecord => ({
  transport: 'stdio',
  runtime: 'node',
  command: 'npx',
  args: [],
  env: {},
  url: null,
  headers: {},
  enabled: true,
  createdAt: 1,
  trustReadOnly: false,
  pythonPackages: [],
  ...over
})

const runtime = (
  over: Partial<McpServerRuntime> & Pick<McpServerRuntime, 'id' | 'status'>
): McpServerRuntime =>
  ({
    ...server({ id: over.id, name: over.name ?? over.id }),
    tools: [],
    lastError: null,
    ...over
  }) as McpServerRuntime

const mcpEntry = (
  over: Partial<ToolPolicyEntry> & Pick<ToolPolicyEntry, 'id' | 'name'>
): ToolPolicyEntry => ({
  source: 'mcp',
  permission: 'auto',
  state: 'needs-explicit',
  dynamic: false,
  reasons: [],
  ...over
})

const snapshotFor = (
  assistantId: string,
  tools: ToolPolicyEntry[]
): ToolPolicySnapshot => ({
  tools: [],
  shell: { enabled: true, policy: 'confirm', confirmReasons: [], denyReasons: [] },
  mcpStoppedServers: 0,
  assistant: {
    id: assistantId,
    name: assistantId,
    isBuiltin: false,
    permissions: [],
    emptyPermissions: false,
    loadSkillAvailable: true,
    tools
  }
})

describe('技能状态：四种 fixture', () => {
  const sDisabledFree = skill({ id: 's-off', name: '停用且没人绑', enabled: false })
  const sDisabledBound = skill({ id: 's-off-bound', name: '停用但还挂着引用', enabled: false })
  const sOnFree = skill({ id: 's-on', name: '启用未绑定' })
  const sOnBound = skill({ id: 's-on-bound', name: '启用且已绑定' })
  const sOnBoundTwo = skill({ id: 's-on-bound-two', name: '启用且绑了两个助手' })
  const assistants: AssistantRecord[] = [
    assistant({ id: 'a1', name: '助手一', skillIds: ['s-off-bound', 's-on-bound'] }),
    assistant({ id: 'a2', name: '助手二', skillIds: ['s-on-bound-two'] }),
    assistant({ id: 'a3', name: '助手三', skillIds: ['s-on-bound-two', 's-on-bound-two'] })
  ]

  it('关＝停用（即使仍被助手引用，运行时也按停用处理）', () => {
    expect(deriveSkillCapabilityState(sDisabledFree, 0)).toBe('disabled')
    expect(deriveSkillCapabilityState(sDisabledBound, countSkillBoundAssistants(assistants, sDisabledBound.id))).toBe('disabled')
    expect(countSkillBoundAssistants(assistants, sDisabledBound.id)).toBe(1)
  })

  it('开＋0 引用＝已启用未绑定', () => {
    expect(deriveSkillCapabilityState(sOnFree, countSkillBoundAssistants(assistants, sOnFree.id))).toBe('enabled-unbound')
  })

  it('开＋1 引用＝已绑定 1 个助手', () => {
    expect(deriveSkillCapabilityState(sOnBound, countSkillBoundAssistants(assistants, sOnBound.id))).toBe('bound')
    expect(countSkillBoundAssistants(assistants, sOnBound.id)).toBe(1)
  })

  it('开＋N 引用＝已绑定 N 个助手（同一助手内重复只算 1）', () => {
    expect(countSkillBoundAssistants(assistants, sOnBoundTwo.id)).toBe(2)
    expect(deriveSkillCapabilityState(sOnBoundTwo, 2)).toBe('bound')
  })

  it('同一助手重复写同一个 skillId 只算一个助手', () => {
    const dup = skill({ id: 's-dup', name: '重复引用' })
    const a = assistant({ id: 'a-dup', name: '重复助手', skillIds: ['s-dup', 's-dup'] })
    expect(countSkillBoundAssistants([a], dup.id)).toBe(1)
  })
})

describe('MCP 状态：四种运行状态 + enabled 不参与', () => {
  it('没有 runtime＝已配置未启动', () => {
    expect(deriveMcpCapabilityState(undefined)).toBe('stopped')
    expect(deriveMcpCapabilityState(runtime({ id: 'x', status: 'stopped' }))).toBe('stopped')
  })

  it('starting', () => {
    expect(deriveMcpCapabilityState(runtime({ id: 'x', status: 'starting' }))).toBe('starting')
  })

  it('error', () => {
    expect(deriveMcpCapabilityState(runtime({ id: 'x', status: 'error' }))).toBe('error')
  })

  it('running（工具名只在这档带出）', () => {
    expect(deriveMcpCapabilityState(runtime({ id: 'x', status: 'running' }))).toBe('running')
  })

  it('record.enabled 不参与状态：enabled=true 但没 runtime 仍是未启动；enabled=false 但 running 仍是运行中', () => {
    const groups = buildCapabilityGroups(
      baseInput({
        servers: [
          server({ id: 's1', name: 'enabled-true', enabled: true }),
          server({ id: 's2', name: 'enabled-false', enabled: false })
        ],
        runtimes: [runtime({ id: 's2', status: 'running' })]
      })
    )
    expect(groups.mcpServers[0]!.state).toBe('stopped')
    expect(groups.mcpServers[1]!.state).toBe('running')
  })
})

describe('MCP 授权数只从 policySnapshot 派生', () => {
  const srv = server({ id: 'srv-a', name: 'srv-a' })

  it('按 Server 汇总：至少一条工具 granted 的助手才计数', () => {
    const snaps = [
      snapshotFor('a1', [mcpEntry({ id: 'mcp:srv-a:read', name: 'read', mcpServerId: 'srv-a', granted: true })]),
      snapshotFor('a2', [mcpEntry({ id: 'mcp:srv-a:read', name: 'read', mcpServerId: 'srv-a', granted: false })]),
      snapshotFor('a3', [mcpEntry({ id: 'mcp:srv-b:read', name: 'read', mcpServerId: 'srv-b', granted: true })])
    ]
    expect(countAuthorizedAssistants('srv-a', snaps)).toBe(1)
    expect(countAuthorizedAssistants('srv-b', snaps)).toBe(1)
  })

  it('注册表全量视角（没有 assistant 段、没有 granted）一律不计', () => {
    const registry: ToolPolicySnapshot = {
      tools: [mcpEntry({ id: 'mcp:srv-a:read', name: 'read', mcpServerId: 'srv-a' })],
      shell: { enabled: true, policy: 'confirm', confirmReasons: [], denyReasons: [] },
      mcpStoppedServers: 1
    }
    expect(countAuthorizedAssistants('srv-a', [registry])).toBe(0)
  })

  it('运行中才给出授权数；未运行一律 null（不知道，不是 0）', () => {
    const groups = buildCapabilityGroups(
      baseInput({
        servers: [srv, server({ id: 'srv-b', name: 'srv-b' })],
        runtimes: [runtime({ id: 'srv-a', status: 'running' })],
        snapshots: [
          snapshotFor('a1', [mcpEntry({ id: 'mcp:srv-a:read', name: 'read', mcpServerId: 'srv-a', granted: true })])
        ]
      })
    )
    expect(groups.mcpServers[0]!.authorizedAssistants).toBe(1)
    expect(groups.mcpServers[1]!.authorizedAssistants).toBeNull()
  })

  it('快照整份没读到（null）时，运行中的 Server 也是 null', () => {
    const groups = buildCapabilityGroups(
      baseInput({ servers: [srv], runtimes: [runtime({ id: 'srv-a', status: 'running' })], snapshots: null })
    )
    expect(groups.mcpServers[0]!.authorizedAssistants).toBeNull()
  })

  it('归属识别：优先 mcpServerId，旧形状按 mcp:<serverId>: 前缀兜底；内置工具不混入', () => {
    const tools: ToolPolicyEntry[] = [
      mcpEntry({ id: 'mcp:srv-a:read', name: 'read', mcpServerId: 'srv-a' }),
      mcpEntry({ id: 'mcp:srv-a:write', name: 'write' }),
      mcpEntry({ id: 'mcp:srv-b:read', name: 'read', mcpServerId: 'srv-b' }),
      {
        id: 'fs.read',
        name: 'fs_read',
        source: 'builtin',
        permission: 'auto',
        state: 'available',
        dynamic: false,
        reasons: []
      }
    ]
    expect(mcpEntriesOfServer(tools, 'srv-a').map((e) => e.id)).toEqual([
      'mcp:srv-a:read',
      'mcp:srv-a:write'
    ])
  })
})

describe('分组：四类不混排', () => {
  it('每组只装本类条目，四组都在', () => {
    const groups = buildCapabilityGroups(baseInput({}))
    expect(Object.keys(groups)).toEqual(['installedSkills', 'onlineSkills', 'mcpServers', 'mcpTemplates'])
    expect(groups.installedSkills.every((i) => i.kind === 'installedSkill')).toBe(true)
    expect(groups.onlineSkills.every((i) => i.kind === 'onlineSkill')).toBe(true)
    expect(groups.mcpServers.every((i) => i.kind === 'mcpServer')).toBe(true)
    expect(groups.mcpTemplates.every((i) => i.kind === 'mcpTemplate')).toBe(true)
  })

  it('模板已配置＝存在同名 Server（模板 id 即 draft.name）', () => {
    const groups = buildCapabilityGroups(
      baseInput({ servers: [server({ id: 'x', name: 'fetch' })] })
    )
    const fetch = groups.mcpTemplates.find((i) => i.template.id === 'fetch')!
    expect(fetch.configured).toBe(true)
    const others = groups.mcpTemplates.filter((i) => i.template.id !== 'fetch')
    expect(others.every((i) => !i.configured)).toBe(true)
  })
})

describe('搜索与排序：全匹配 > 前缀 > 子串 > 描述；同档已就绪优先', () => {
  const items = buildCapabilityGroups(
    baseInput({
      assistants: [assistant({ id: 'a1', name: '助手一', skillIds: ['s-on-bound'] })],
      onlineSkills: [
        { id: 'o1', name: 'fetch 在线版', url: 'https://example.com/fetch.json' },
        { id: 'o2', name: '完全无关', description: '正文里提到 fetch 一下', url: 'https://example.com/x.json' }
      ],
      skills: [
        skill({ id: 's-exact', name: 'fetch' }),
        skill({ id: 's-prefix', name: 'fetch-reader' }),
        skill({ id: 's-sub', name: 'my-fetch' }),
        skill({ id: 's-desc', name: '别的', description: '可以 fetch 网页' }),
        skill({ id: 's-on-bound', name: 'fetch-fast' }),
        skill({ id: 's-bound-desc', name: 'zzz', description: 'fetch' })
      ]
    })
  ).installedSkills

  it('档位函数：0/1/2/3 与不匹配的 null', () => {
    expect(matchTier('Fetch ', { name: 'fetch' })).toBe(0)
    expect(matchTier('fet', { name: 'fetch-reader' })).toBe(1)
    expect(matchTier('ch-r', { name: 'fetch-reader' })).toBe(2)
    expect(matchTier('网页', { name: '别的', description: '可以 fetch 网页' })).toBe(3)
    expect(matchTier('tools', { name: 'srv', toolNames: ['browser_tools'] })).toBe(3)
    expect(matchTier('不存在', { name: 'srv', description: '', toolNames: ['read'] })).toBeNull()
  })

  it('四档顺序成形，同档时已就绪优先', () => {
    const ids = skillIds(rankAndFilterItems(items, 'fetch'))
    // 0 全匹配
    expect(ids[0]).toBe('s-exact')
    // 1 前缀档里两发：已就绪（已绑定）的 s-on-bound 排在 s-prefix 前
    expect(ids.slice(1, 3)).toEqual(['s-on-bound', 's-prefix'])
    expect(ids.indexOf('s-on-bound')).toBeLessThan(ids.indexOf('s-sub'))
    // 2 子串档
    expect(ids[3]).toBe('s-sub')
    // 3 描述档：都不就绪，保持原顺序
    expect(ids.slice(4)).toEqual(['s-desc', 's-bound-desc'])
  })

  it('未命中全部剔除；大小写与首尾空格不敏感', () => {
    expect(rankAndFilterItems(items, '  fEtCh  ').length).toBe(items.length)
    expect(rankAndFilterItems(items, '不存在')).toEqual([])
  })

  it('关键词为空：不过滤，只把已就绪的排前面且其余保持原顺序', () => {
    const original = ['s-exact', 's-prefix', 's-sub', 's-desc', 's-on-bound', 's-bound-desc']
    const ranked = skillIds(rankAndFilterItems(items, ''))
    expect(ranked[0]).toBe('s-on-bound')
    expect(ranked.slice(1)).toEqual(original.filter((id) => id !== 's-on-bound'))
  })

  it('MCP Server 运行中才把工具名带进搜索', () => {
    const groups = buildCapabilityGroups(
      baseInput({
        servers: [server({ id: 'srv-a', name: 'demo' }), server({ id: 'srv-b', name: 'other' })],
        runtimes: [
          runtime({
            id: 'srv-a',
            status: 'running',
            tools: [{ id: 'mcp:srv-a:search', name: 'web_search', description: '', parameters: {}, source: 'mcp' }]
          })
        ]
      })
    )
    const ranked = filterCapabilityGroups(groups, 'web_search').mcpServers
    expect(ranked.map((i) => i.server.id)).toEqual(['srv-a'])
    // 未运行那一台没有工具名，同样的关键词不会命中
    expect(rankAndFilterItems(groups.mcpServers, 'web_search').length).toBe(1)
  })

  it('组内排序不跨组：filterCapabilityGroups 四组各自返回', () => {
    const groups = buildCapabilityGroups(
      baseInput({ onlineSkills: [{ id: 'o1', name: 'fetch', url: 'u' }] })
    )
    const filtered = filterCapabilityGroups(groups, 'fetch')
    expect(filtered.onlineSkills.length).toBe(1)
    expect(filtered.installedSkills.length).toBe(0)
  })

  it('就绪口径：技能要已启用且已绑定；模板要已配置；在线一律否', () => {
    const groups = buildCapabilityGroups(
      baseInput({
        assistants: [assistant({ id: 'a1', name: 'a1', skillIds: ['s-on-bound'] })],
        skills: [skill({ id: 's-on-bound', name: 'bound' }), skill({ id: 's-on', name: 'unbound' })],
        servers: [server({ id: 'x', name: 'fetch' })],
        runtimes: [runtime({ id: 'x', status: 'running' })],
        onlineSkills: [{ id: 'o', name: 'online', url: 'u' }]
      })
    )
    expect(isItemReady(groups.installedSkills[0]!)).toBe(true)
    expect(isItemReady(groups.installedSkills[1]!)).toBe(false)
    expect(isItemReady(groups.mcpServers[0]!)).toBe(true)
    expect(isItemReady(groups.mcpTemplates.find((i) => i.template.id === 'fetch')!)).toBe(true)
    expect(isItemReady(groups.onlineSkills[0]!)).toBe(false)
  })
})

describe('夹具量级自证', () => {
  it('内置模板清单是数据源（现数 9 条，不是写死在能力中心里的 6 条）', () => {
    // 用户口径写的是「6 个模板」，但代码里的 listMcpTemplates() 现有 9 条。
    // 能力中心直接消费这份清单，不另写白名单；数量变化由本用例点出来。
    expect(listMcpTemplates().length).toBe(9)
  })
})

/** 默认输入：空组；测试按需覆盖 */
function baseInput(over: Partial<CapabilityInput>): CapabilityInput {
  const templates = listMcpTemplates()
  return {
    skills: [],
    assistants: [],
    onlineSkills: [],
    servers: [],
    runtimes: [],
    templates,
    templateDescriptions: {},
    snapshots: [],
    ...over
  }
}

/** 让 McpServerItem 的类型在这里被用到（避免只测 shape 不测类型） */
const _typeProbe: McpServerItem['state'][] = ['stopped', 'starting', 'error', 'running']
void _typeProbe

/** 只取技能 id（测试里的平铺视图只关心顺序） */
function skillIds(items: CapabilityItem[]): string[] {
  return items.map((i) => (i.kind === 'installedSkill' ? i.skill.id : ''))
}
