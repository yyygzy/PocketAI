// P1-5 纯函数：流程模板的生成/导出/导入/启动前闸门
//
// 钉住的语义（都能失败）：
//  · 工具序列按调用顺序拆开、只留参数键名；
//  · 导出 JSON **不含** toolPermissions / id / 参数值；
//  · 导入文件即使写了授权也一律清空，并如实回传被丢弃的条数；
//  · 缺引用 / 一条授权都没确认 / 勾了但这一轮拿不到授权时 blocked=true，清单可逐条列出；
//  · 本机不存在的工具单独列清单（不影响"已确认"的判定）。
import { describe, it, expect } from 'vitest'
import {
  RUNBOOK_EXPORT_VERSION,
  buildRunbookExportPayload,
  evaluateRunbookStart,
  extractRunbookSteps,
  isAbsolutePathLike,
  missingRunbookRefs,
  resolveRunbookImportItem,
  summarizePrompt,
  uniqueRunbookTools,
  type RunbookRecord
} from '../src/shared/runbook'

const record = (over: Partial<RunbookRecord> = {}): RunbookRecord => ({
  id: 'rb-1',
  name: '每周巡检',
  promptSummary: '检查昨天的构建日志并汇总失败项',
  steps: [
    { toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] },
    { toolName: 'kb_search', toolId: 'kb.search', argKeys: ['query', 'topK'] }
  ],
  refs: [
    { kind: 'skill', id: 'skill-1', label: '日志分析' },
    { kind: 'knowledge_base', id: 'kb-1', label: '运维手册' },
    { kind: 'mcp', id: 'srv-1', label: 'CI 服务' },
    { kind: 'path', id: 'C:\\work\\logs', label: 'C:\\work\\logs' }
  ],
  toolPermissions: ['shell.exec', '*'],
  createdAt: 1,
  updatedAt: 2,
  ...over
})

describe('extractRunbookSteps', () => {
  it('只取工具步，按并行调用顺序拆开并只保留参数键名', () => {
    const steps = extractRunbookSteps([
      { stepType: 'llm' },
      {
        stepType: 'tools',
        toolName: 'shell_exec, kb_search',
        toolArgs: 'shell_exec {"command":"rm -rf /tmp/x"}\nkb_search {"query":"secret-token","topK":5}'
      },
      { stepType: 'final' }
    ])
    expect(steps.map((s) => s.toolName)).toEqual(['shell_exec', 'kb_search'])
    expect(steps[0]!.argKeys).toEqual(['command'])
    expect(steps[1]!.argKeys).toEqual(['query', 'topK'])
    // 值不进模板：整份 JSON 里不该出现任何参数值
    expect(JSON.stringify(steps)).not.toContain('rm -rf')
    expect(JSON.stringify(steps)).not.toContain('secret-token')
  })

  it('参数被截断/不是 JSON 时保留工具名、键名留空（不猜）', () => {
    const steps = extractRunbookSteps([
      { stepType: 'tools', toolName: 'fs_write', toolArgs: 'fs_write {"path":"C:\\\\a' }
    ])
    expect(steps).toEqual([{ toolName: 'fs_write', toolId: null, argKeys: [] }])
  })

  it('解析器给的授权 id 会写进步骤（模型工具名 ≠ 授权 id）', () => {
    const steps = extractRunbookSteps(
      [{ stepType: 'tools', toolName: 'kb_search', toolArgs: 'kb_search {"query":"x"}' }],
      (name) => (name === 'kb_search' ? 'kb.search' : null)
    )
    expect(steps[0]!.toolId).toBe('kb.search')
  })
})

describe('summarizePrompt / isAbsolutePathLike', () => {
  it('压平空白并截断', () => {
    expect(summarizePrompt('  第一行\n\n第二行  ')).toBe('第一行 第二行')
    expect(summarizePrompt('x'.repeat(600)).length).toBe(501)
  })

  it('认 Windows / UNC / POSIX 绝对路径，不认相对路径', () => {
    expect(isAbsolutePathLike('C:\\work')).toBe(true)
    expect(isAbsolutePathLike('\\\\server\\share')).toBe(true)
    expect(isAbsolutePathLike('/home/u/project')).toBe(true)
    expect(isAbsolutePathLike('./relative')).toBe(false)
  })
})

describe('导出载荷（SEC-3 同口径）', () => {
  it('不带工具授权、不带本机 id，也不带参数值', () => {
    const payload = buildRunbookExportPayload([record({ toolPermissions: ['grant-only-local'] })])
    expect(payload.version).toBe(RUNBOOK_EXPORT_VERSION)
    expect(payload.kind).toBe('pocketai.runbooks')
    expect(payload.runbooks).toHaveLength(1)
    const json = JSON.stringify(payload)
    expect(json).not.toContain('toolPermissions')
    // 授权值只在本机：导出后不该出现
    expect(json).not.toContain('grant-only-local')
    expect(json).not.toContain('rb-1')
    // 步骤与引用照常带（引用用于导入后的缺失清单）
    expect(payload.runbooks[0]!.steps.map((s) => s.toolName)).toEqual(['shell_exec', 'kb_search'])
    expect(payload.runbooks[0]!.refs).toHaveLength(4)
  })
})

describe('导入解析', () => {
  it('缺 name 视为无效', () => {
    expect(resolveRunbookImportItem({ name: '   ' })).toBeNull()
    expect(resolveRunbookImportItem(null)).toBeNull()
  })

  it('文件里写了工具授权也一律清空（必须用户重勾）', () => {
    const resolved = resolveRunbookImportItem({
      name: '外部模板',
      promptSummary: '做点什么',
      steps: [{ toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] }],
      refs: [{ kind: 'skill', id: 's', label: '技能' }],
      toolPermissions: ['*', 'shell.exec', 'fs_write']
    })
    expect(resolved).not.toBeNull()
    expect(resolved!.draft.toolPermissions).toEqual([])
    expect(resolved!.droppedTools).toBe(3)
  })

  it('坏引用只丢那一条并计数，不整单失败', () => {
    const resolved = resolveRunbookImportItem({
      name: 't',
      steps: [],
      refs: [
        { kind: 'skill', id: 'ok', label: 'ok' },
        { kind: 'unknown', id: 'x', label: 'x' },
        { kind: 'mcp', id: '', label: '空 id' },
        'not-an-object'
      ]
    })
    expect(resolved!.draft.refs).toEqual([{ kind: 'skill', id: 'ok', label: 'ok' }])
    expect(resolved!.droppedRefs).toBe(3)
  })
})

describe('启动前校验', () => {
  const lookup = {
    skillIds: new Set(['skill-1']),
    knowledgeBaseIds: new Set<string>(),
    mcpServerIds: new Set(['srv-1']),
    pathExists: (p: string) => p === 'C:\\work\\logs'
  }
  // 本机注册表 + 这一轮的授权面（渲染端从 TOOL_POLICY_SNAPSHOT 取，这里直接给结果）
  const known = [
    { id: 'shell.exec', name: 'shell_exec' },
    { id: 'kb.search', name: 'kb_search' },
    { id: 'mcp:ci:deploy', name: 'mcp_ci_deploy' }
  ]
  const granted = new Set(['shell.exec', 'kb.search', 'mcp:ci:deploy'])

  it('逐条列出缺失引用（知识库不存在、相对路径不算可用）', () => {
    const refs = [
      { kind: 'skill' as const, id: 'skill-1', label: '有' },
      { kind: 'knowledge_base' as const, id: 'kb-1', label: '缺的知识库' },
      { kind: 'mcp' as const, id: 'srv-1', label: '有' },
      { kind: 'path' as const, id: 'C:\\work\\logs', label: '有' },
      { kind: 'path' as const, id: './relative', label: '相对路径' }
    ]
    const missing = missingRunbookRefs(refs, lookup)
    expect(missing.map((r) => r.label)).toEqual(['缺的知识库', '相对路径'])
  })

  it('缺引用时 blocked=true，清单原样带出', () => {
    const gate = evaluateRunbookStart(record({ toolPermissions: ['shell.exec', 'kb.search'] }), {
      missingRefs: [{ kind: 'mcp', id: 'srv-9', label: '另一台机器的 MCP' }],
      known,
      grantedIds: granted
    })
    expect(gate.blocked).toBe(true)
    expect(gate.missingRefs).toHaveLength(1)
    expect(gate.unconfirmed).toBe(false)
  })

  it('导入后授权为空时同样 blocked（必须重勾）', () => {
    const gate = evaluateRunbookStart(record({ toolPermissions: [] }), { missingRefs: [], known, grantedIds: granted })
    expect(gate.unconfirmed).toBe(true)
    expect(gate.blocked).toBe(true)
  })

  it('勾了但这一轮拿不到授权的工具要拦下，并逐条列出', () => {
    const gate = evaluateRunbookStart(record({ toolPermissions: ['shell.exec', 'kb.search'] }), {
      missingRefs: [],
      known,
      grantedIds: new Set(['kb.search', 'mcp:ci:deploy'])
    })
    expect(gate.unauthorizedTools.map((t) => t.toolId)).toEqual(['shell.exec'])
    expect(gate.blocked).toBe(true)
  })

  it('本机没有的工具只列清单、不当成"没确认"：其余勾齐即可放行', () => {
    const gate = evaluateRunbookStart(
      record({
        steps: [
          { toolName: 'shell_exec', toolId: 'shell.exec', argKeys: ['command'] },
          { toolName: 'mcp_old_gone', toolId: 'mcp:old:gone', argKeys: [] }
        ],
        toolPermissions: ['shell.exec', 'mcp:old:gone']
      }),
      { missingRefs: [], known, grantedIds: granted }
    )
    expect(gate.missingTools.map((t) => t.toolName)).toEqual(['mcp_old_gone'])
    expect(gate.unconfirmed).toBe(false)
    expect(gate.blocked).toBe(false)
  })

  it('老模板 toolId 为空时按模型侧工具名回注册表解析', () => {
    const gate = evaluateRunbookStart(
      record({
        steps: [{ toolName: 'kb_search', toolId: null, argKeys: ['query'] }],
        toolPermissions: ['kb.search']
      }),
      { missingRefs: [], known, grantedIds: granted }
    )
    expect(gate.tools).toEqual([
      { toolName: 'kb_search', toolId: 'kb.search', available: true, confirmed: true, granted: true }
    ])
    expect(gate.blocked).toBe(false)
  })

  it('引用齐全 + 授权齐全且这一轮拿得到才放行', () => {
    const gate = evaluateRunbookStart(record({ toolPermissions: ['shell.exec', 'kb.search'] }), {
      missingRefs: [],
      known,
      grantedIds: granted
    })
    expect(gate.blocked).toBe(false)
    expect(gate.tools.map((t) => [t.toolId, t.available, t.confirmed, t.granted])).toEqual([
      ['shell.exec', true, true, true],
      ['kb.search', true, true, true]
    ])
  })
})

describe('uniqueRunbookTools', () => {
  it('按授权 id 去重，同一工具的并行调用只留一项', () => {
    const tools = uniqueRunbookTools([
      { toolName: 'kb_search', toolId: 'kb.search', argKeys: [] },
      { toolName: 'kb_search', toolId: 'kb.search', argKeys: [] },
      { toolName: 'shell_exec', toolId: null, argKeys: [] }
    ])
    expect(tools).toEqual([
      { toolName: 'kb_search', toolId: 'kb.search' },
      { toolName: 'shell_exec', toolId: 'shell_exec' }
    ])
  })
})
