// B54 的真机替代验证：**真起一个 stdio MCP server**、真库、真 toolRegistry
//
// 为什么要这条：`countMcpHeldBack` 的单测喂的是手搓 ToolSchema 数组，于是"提示里的数字
// 等于那个 Server 真实暴露的工具条数"这半句其实没人证过——工具条数要经
// mcpManager.normalizeToolList 的协议边界收紧（形状/数量/大小），id 也要经
// `mcp:<serverId>:<name>` 拼装与重名改名，两步都不在单测路径里。
// 这里把 server 换成真进程（tests/fixtures/mcp-probe-server.cjs，3 个工具），
// 走 initialize → tools/list 的真握手，再让引擎用同一份 listAll() 计数。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-mcp-held-back'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { mcpServerRepo } from '../src/main/db/repositories/mcp-server.repo'
import { mcpManager } from '../src/main/mcp/manager'
import { toolRegistry } from '../src/main/tools/registry'
import { countMcpHeldBack } from '../src/main/agent/engine'

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-probe-server.cjs')
/** 探针 server 自报的工具数：改 fixture 要同步改这里，否则计数断言会假绿 */
const PROBE_TOOL_COUNT = 3

let serverId = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  const rec = mcpServerRepo.save({
    name: 'probe-server',
    transport: 'stdio',
    runtime: 'node',
    command: process.execPath,
    args: [FIXTURE],
    enabled: true
  })
  serverId = rec.id
})

afterAll(async () => {
  await mcpManager.stopAll().catch(() => {})
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('B54：MCP 被挡计数走真 server / 真注册表', () => {
  it('真握手拉到的工具条数就是 3（协议边界收紧后没有被悄悄丢掉）', async () => {
    await mcpManager.start(serverId)
    const tools = await mcpManager.listTools(serverId)
    expect(tools).toHaveLength(PROBE_TOOL_COUNT)
    expect(tools.map((t) => t.id).sort()).toEqual(
      ['probe_alpha', 'probe_beta', 'probe_gamma'].map((n) => `mcp:${serverId}:${n}`)
    )
  })

  it("'*' 授权下被挡的 MCP 工具数 = 该 Server 暴露的工具条数（3）", () => {
    expect(countMcpHeldBack(['*'], toolRegistry.listAll())).toBe(PROBE_TOOL_COUNT)
  })

  it('逐条勾了哪些，被挡数就少哪些（勾一条 ⇒ 2）', () => {
    const granted = `mcp:${serverId}:probe_alpha`
    expect(countMcpHeldBack(['*', granted], toolRegistry.listAll())).toBe(PROBE_TOOL_COUNT - 1)
    expect(countMcpHeldBack(['*', granted, `mcp:${serverId}:probe_beta`], toolRegistry.listAll())).toBe(1)
  })

  it('反向对照：不用 `*` 的助手不该出现这一行（计数恒 0，哪怕 MCP 工具全没勾）', () => {
    expect(countMcpHeldBack(['time_now'], toolRegistry.listAll())).toBe(0)
    expect(countMcpHeldBack([], toolRegistry.listAll())).toBe(0)
  })

  it('`*` 确实不放行 MCP 工具（口径收紧的落点在真注册表上生效）', () => {
    const names = toolRegistry.filterByPermissions(['*']).map((t) => t.id)
    expect(names.some((n) => n.startsWith('mcp:'))).toBe(false)
    // 逐条点名后同一个 id 就进来了——提示里"请到助手 → 工具权限逐个勾选"才是可执行的
    const granted = `mcp:${serverId}:probe_alpha`
    expect(toolRegistry.filterByPermissions(['*', granted]).map((t) => t.id)).toContain(granted)
  })

  it('真调用一次 MCP 工具拿得到结果（证明"数字减一"那条路是真的能干活，不是空壳）', async () => {
    const res = (await mcpManager.invokeTool(serverId, 'probe_alpha', {})) as {
      content: { text: string }[]
    }
    expect(JSON.stringify(res)).toContain('紫岚-7731')
  })
})
