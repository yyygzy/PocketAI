// @vitest-environment node
// 工具面分组与「运行级按需暴露」（V4 工具面治理，候选 A）
//
// 两条主线：
//  1) **覆盖**：`TOOL_GROUP_OF` 必须覆盖运行时 `listBuiltin()` 的每一枚工具——漏一个就等于
//     它被分到"不存在的组"，而 fail-open 会让它照旧保留、只是分组表失真；
//     `TOOL_GROUP_OF` 里也不许留已经删掉的 id（否则改错一行没人发现）。
//  2) **选择**：只裁 `'*'`、显式逐条授权不裁、MCP 不裁、未知 id 不裁、组数封顶、结果确定。
//
// 环境：registry 的 import 链会拉到 portable（顶层读 app.isPackaged）与几个仓库，
// 按 `tool-policy-same-source-417.test.ts` 的既有写法桩掉；shell 配置单独桩成"已开启"，
// 这样 listBuiltin 才能真的凑齐 14 静态 + fs 3 + shell 1 + skill 1 = 19。
import { describe, expect, it, vi } from 'vitest'

const WS = 'C:\\tmp\\pocketai-tool-groups-test'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/tools/shell-config', () => ({
  getShellConfig: () => ({ enabled: true, policy: 'confirm' })
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (k: string) => (k === 'agent.workspace_dir' ? WS : null),
    set: () => {},
    delete: () => {}
  }
}))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { list: () => [], listEnabledByIds: () => [], get: () => undefined }
}))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listRuntimes: () => [], callTool: async () => ({ isError: false }) }
}))

import { toolRegistry } from '../src/main/tools/registry'
import {
  ALWAYS_ON_GROUPS,
  MAX_EXPOSED_GROUPS,
  PRUNABLE_GROUPS,
  TOOL_GROUP_OF,
  pickToolGroups,
  scoreToolGroups,
  selectToolSurface
} from '../src/shared/tool-groups'
import type { ToolSchema } from '../src/shared/types'

function builtin(id: string): ToolSchema {
  return {
    id,
    name: id.replace(/[^A-Za-z0-9_]/g, '_'),
    description: `${id} 的描述`,
    parameters: { type: 'object', properties: { q: { type: 'string', description: '查询' } } },
    source: 'builtin',
    permission: 'auto'
  }
}

function mcp(id: string): ToolSchema {
  return {
    ...builtin(id),
    source: 'mcp',
    mcpServerId: 'srv'
  }
}

describe('分组表覆盖运行时工具面', () => {
  it('listBuiltin() 的每一枚工具都在 TOOL_GROUP_OF 里', () => {
    const ids = toolRegistry.listBuiltin().map((t) => t.id)
    // 先钉住"这个环境确实把 19 枚都注册出来了"，否则下面的覆盖断言会空转
    expect(ids).toHaveLength(19)
    const missing = ids.filter((id) => !TOOL_GROUP_OF[id])
    expect(missing).toEqual([])
  })

  it('TOOL_GROUP_OF 里没有已经不存在的 id', () => {
    const live = new Set(toolRegistry.listBuiltin().map((t) => t.id))
    const stale = Object.keys(TOOL_GROUP_OF).filter((id) => !live.has(id))
    expect(stale).toEqual([])
  })

  it('可裁剪组与常驻组不重叠，且都落在已知组名里', () => {
    for (const g of PRUNABLE_GROUPS) {
      expect(ALWAYS_ON_GROUPS.has(g)).toBe(false)
    }
    const known = new Set([...ALWAYS_ON_GROUPS, ...PRUNABLE_GROUPS])
    for (const g of Object.values(TOOL_GROUP_OF)) {
      expect(known.has(g)).toBe(true)
    }
  })
})

describe('pickToolGroups — 消息里命中哪些可裁剪组', () => {
  it('没有任何命中 → 空（只发常驻组）', () => {
    expect(pickToolGroups('你好')).toEqual([])
  })

  it('文件类消息 → file', () => {
    expect(pickToolGroups('帮我读取工作目录里的 report.md 文件')).toContain('file')
  })

  it('联网类消息 → net', () => {
    expect(pickToolGroups('搜索一下最新的新闻')).toContain('net')
  })

  it('同时命中两组 → 两组都进（上限 2）', () => {
    const groups = pickToolGroups('帮我搜一下网页，然后写进文件里')
    expect(groups).toHaveLength(2)
    expect(new Set(groups)).toEqual(new Set(['net', 'file']))
  })

  it('命中三组以上 → 只取分数最高的 2 组', () => {
    const msg = '提醒 提醒 提醒 日程 文件 搜索 网页 天气 链接 目录'
    expect(pickToolGroups(msg)).toHaveLength(MAX_EXPOSED_GROUPS)
  })

  it('同一句话恒得同一结果（确定性，不依赖 locale）', () => {
    const msg = '读取文件并搜索网页'
    expect(scoreToolGroups(msg)).toEqual(scoreToolGroups(msg))
  })
})

describe('selectToolSurface — 选择规则', () => {
  const tools = [...toolRegistry.listBuiltin(), mcp('mcp:demo:read_x')]

  it("'*' + 文件类消息 → 裁掉未命中的可裁剪组，MCP 原样保留", () => {
    const r = selectToolSurface({
      tools,
      permissions: ['*'],
      message: '读取工作目录里的文件',
      mode: 'grouped'
    })
    const ids = new Set(r.tools.map((t) => t.id))
    expect(ids.has('fs.read')).toBe(true)
    expect(ids.has('web.search')).toBe(false)
    expect(ids.has('reminder.set')).toBe(false)
    // 常驻组一枚不少
    for (const id of ['time.now', 'calculator', 'js.eval', 'kb.search', 'todo.write', 'memory.save', 'shell.exec', 'skill.load', 'agent.delegate']) {
      expect(ids.has(id)).toBe(true)
    }
    // MCP 工具不参与分组裁剪
    expect(ids.has('mcp:demo:read_x')).toBe(true)
    expect(r.groups).toEqual(['file'])
    expect(r.heldBackTools).toBe(3 + 4) // net 3 枚 + schedule 4 枚
  })

  it('无关键词 → 只留常驻组 + MCP', () => {
    const r = selectToolSurface({ tools, permissions: ['*'], message: '你好', mode: 'grouped' })
    const ids = new Set(r.tools.map((t) => t.id))
    expect(ids.has('fs.read')).toBe(false)
    expect(ids.has('web.search')).toBe(false)
    expect(ids.has('calendar.read')).toBe(false)
    expect(ids.has('mcp:demo:read_x')).toBe(true)
    expect(r.heldBackTools).toBe(3 + 3 + 4)
    expect(r.groups).toEqual([])
  })

  it('显式逐条授权（不含 *）→ 一枚都不裁', () => {
    const r = selectToolSurface({
      tools,
      permissions: ['fs.read', 'web.search'],
      message: '读取文件',
      mode: 'grouped'
    })
    expect(r.tools).toHaveLength(tools.length)
    expect(r.heldBackTools).toBe(0)
    expect(r.groups).toEqual([])
  })

  it("mode='full' → 与治理前一致", () => {
    const r = selectToolSurface({ tools, permissions: ['*'], message: '你好', mode: 'full' })
    expect(r.tools).toHaveLength(tools.length)
    expect(r.heldBackTools).toBe(0)
  })

  it('未登记分组的内置工具 fail-open（新增工具忘登记也不会静默消失）', () => {
    const unknown = builtin('brand.new.tool')
    const r = selectToolSurface({
      tools: [...tools, unknown],
      permissions: ['*'],
      message: '你好',
      mode: 'grouped'
    })
    expect(r.tools.map((t) => t.id)).toContain('brand.new.tool')
  })

  it('工具顺序与入参一致（不重排，便于 {{tools}} 文本稳定）', () => {
    const r = selectToolSurface({
      tools,
      permissions: ['*'],
      message: '读取文件',
      mode: 'grouped'
    })
    const inputOrder = tools.filter((t) => r.tools.some((k) => k.id === t.id)).map((t) => t.id)
    expect(r.tools.map((t) => t.id)).toEqual(inputOrder)
  })
})
