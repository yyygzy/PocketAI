// McpManager 生命周期测试
//
// 覆盖 src/main/mcp/manager.ts 的核心路径：start 握手 / stop / restart /
// listTools / callTool / handleExit 自动重启 / handleLog / 订阅 / 稳定运行复位。
//
// 策略：
// - vi.mock json-rpc：替换 StdioJsonRpcClient 为可控桩，行为委托 mocks.spawnImpl/requestImpl
// - vi.mock mcp-server.repo / python-env / portable / logger：割裂外部依赖
// - 每用例 new McpManager() 隔离 runtimes/startingPromises 状态
// - status 事件用 onStatus 数组捕获断言触发顺序与字段
// - stableTimer 用 vi.useFakeTimers 推进 STABLE_RUNNING_MS 验证 autoRestarts 复位
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { McpCallEvent, McpServerRecord, McpServerStatusEvent } from '../src/shared/types'

// ---------- mock 工厂 ----------

interface FakeClient {
  opts: Record<string, unknown>
  pid: number
  spawn: ReturnType<typeof vi.fn>
  request: ReturnType<typeof vi.fn>
  notify: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
  callOnLog: (stream: 'stdout' | 'stderr', line: string) => void
  callOnExit: (code: number | null, signal: NodeJS.Signals | null) => void
}

const mocks = vi.hoisted(() => ({
  clients: [] as FakeClient[],
  repoList: [] as McpServerRecord[],
  envState: { status: 'none' } as { status: string },
  // 可注入的 fake 行为：每次调用都查当前值，便于测试挂起 / 抛错
  // requestImpl 接收 (method, params, timeoutMs)，便于按 method 区分握手与 tools/call 行为
  spawnImpl: (async () => {}) as () => Promise<void>,
  requestImpl: (async () => ({})) as (...args: unknown[]) => Promise<unknown>,
  reset() {
    this.clients = []
    this.repoList = []
    this.envState = { status: 'none' }
    this.spawnImpl = async () => {}
    this.requestImpl = async () => ({})
  }
}))

vi.mock('../src/main/mcp/json-rpc', () => ({
  StdioJsonRpcClient: class {
    constructor(opts: Record<string, unknown>) {
      const self: FakeClient = {
        opts,
        pid: 12345,
        spawn: vi.fn(() => mocks.spawnImpl()),
        request: vi.fn((...args: unknown[]) => mocks.requestImpl(...args)),
        notify: vi.fn(),
        shutdown: vi.fn(async () => {}),
        callOnLog: opts.onLog as (s: 'stdout' | 'stderr', l: string) => void,
        callOnExit: opts.onExit as (c: number | null, s: NodeJS.Signals | null) => void
      }
      mocks.clients.push(self)
      return self
    }
  },
  // 与 src/main/mcp/json-rpc.ts 同名同类，供 manager instanceof 收口
  McpTransportError: class McpTransportError extends Error {
    readonly kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.name = 'McpTransportError'
      this.kind = kind
    }
  }
}))

vi.mock('../src/main/mcp/http-transport', () => ({
  HttpJsonRpcClient: class {
    constructor(opts: Record<string, unknown>) {
      const self: FakeClient = {
        opts,
        pid: undefined as unknown as number, // http 无本地进程
        spawn: vi.fn(() => mocks.spawnImpl()),
        request: vi.fn((...args: unknown[]) => mocks.requestImpl(...args)),
        notify: vi.fn(),
        shutdown: vi.fn(async () => {}),
        callOnLog: () => {},
        callOnExit: () => {}
      }
      mocks.clients.push(self)
      return self
    }
  }
}))

vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: {
    list: () => mocks.repoList.slice(),
    get: (id: string) => mocks.repoList.find((r) => r.id === id) ?? null
  }
}))

vi.mock('../src/main/mcp/python-env', () => ({
  pythonEnvService: {
    getEnvState: vi.fn(async () => ({
      serverId: 'x',
      status: mocks.envState.status,
      packages: [],
      pythonVersion: null,
      basePython: null,
      installedPackages: []
    }))
  },
  venvPython: (id: string) => `/venv/${id}/python.exe`,
  venvDir: (id: string) => `/venv/${id}`,
  venvBinDir: (id: string) => `/venv/${id}/bin`
}))

vi.mock('../src/main/portable', () => ({
  MCP_EXTENSIONS_DIR: '/ext/mcp'
}))

vi.mock('node:fs', () => {
  const fs = {
    existsSync: () => true,
    mkdirSync: () => {}
  }
  return { ...fs, default: fs }
})

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {}
  })
}))

// ---------- 导入被测 ----------

import {
  describeStartupExit,
  McpManager,
  startupFailureHint,
  MAX_MCP_TOOLS,
  MAX_MCP_TOOL_DESC_CHARS,
  MAX_MCP_TOOL_SCHEMA_CHARS
} from '../src/main/mcp/manager'
import { McpTransportError } from '../src/main/mcp/json-rpc'

// ---------- 工具 ----------

const BASE_TIME = new Date('2026-01-01T00:00:00Z').getTime()

function makeRecord(over: Partial<McpServerRecord> = {}): McpServerRecord {
  return {
    id: 'srv1',
    name: 'test-srv',
    transport: 'stdio',
    runtime: 'binary',
    command: 'echo',
    args: [],
    env: {},
    url: null,
    headers: {},
    enabled: true,
    createdAt: 0,
    trustReadOnly: false,
    pythonPackages: [],
    ...over
  }
}

let mgr: McpManager
let events: McpServerStatusEvent[]

beforeEach(() => {
  vi.useFakeTimers({ now: BASE_TIME })
  mocks.reset()
  mgr = new McpManager()
  events = []
  mgr.onStatus((e) => events.push(e))
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------- 用例 ----------

describe('McpManager — start 基础校验', () => {
  it('record 不存在 → throw "MCP Server 不存在: id"', async () => {
    await expect(mgr.start('nope')).rejects.toThrow('MCP Server 不存在: nope')
    expect(mocks.clients).toHaveLength(0)
  })

  it('已 running 快路径 → 不重复 spawn', async () => {
    mocks.repoList = [makeRecord()]
    const fake: FakeClient = {
      opts: {},
      pid: 12345,
      spawn: vi.fn(),
      request: vi.fn(),
      notify: vi.fn(),
      shutdown: vi.fn(),
      callOnLog: () => {},
      callOnExit: () => {}
    }
    ;(mgr as unknown as { runtimes: Map<string, unknown> }).runtimes.set('srv1', {
      record: mocks.repoList[0],
      client: fake,
      status: 'running',
      tools: [],
      lastError: null,
      autoRestarts: 0,
      logBuffer: [],
      startToken: 1,
      startPromise: null
    })
    await mgr.start('srv1')
    expect(mocks.clients).toHaveLength(0)
    expect(fake.spawn).not.toHaveBeenCalled()
  })

  it('in-flight 复用：并发两次 start 只 spawn 一次', async () => {
    mocks.repoList = [makeRecord()]
    // 让 spawn 挂起，让首个 start 飞行中
    let resolveSpawn!: () => void
    mocks.spawnImpl = () => new Promise<void>((r) => { resolveSpawn = r })
    const p1 = mgr.start('srv1')
    const p2 = mgr.start('srv1')
    // 同步登记完成，第二次 start 直接复用 in-flight Promise
    expect(mocks.clients).toHaveLength(1)
    // createClient 现为 async，需让 microtask 执行到 client.spawn() 才会赋值 resolveSpawn
    await Promise.resolve()
    resolveSpawn()
    // 让后续 initialize / tools/list 走默认 requestImpl 返回 {} —— 但 start 需要 tools 字段
    // 所以恢复默认 requestImpl 让其返回 { tools: [] }
    mocks.requestImpl = async () => ({ tools: [] })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('running')
    expect(r2).toBe(r1)
  })

  it('HTTP transport 缺 url → throw "HTTP 传输缺少 url"', async () => {
    mocks.repoList = [makeRecord({ transport: 'http', url: null })]
    await expect(mgr.start('srv1')).rejects.toThrow('HTTP 传输缺少 url')
  })

  it('HTTP transport → 用 HttpJsonRpcClient 启动，pid undefined，握手成功', async () => {
    mocks.repoList = [makeRecord({ transport: 'http', url: 'https://example.com/mcp' })]
    mocks.requestImpl = async () => ({ tools: [] })
    const r = await mgr.start('srv1')
    expect(r.status).toBe('running')
    expect(r.pid).toBeUndefined()
    expect(mocks.clients).toHaveLength(1)
    expect(mocks.clients[0]!.opts.url).toBe('https://example.com/mcp')
  })

  it('缺 command → throw "缺少 stdio command"', async () => {
    mocks.repoList = [makeRecord({ command: null })]
    await expect(mgr.start('srv1')).rejects.toThrow('缺少 stdio command')
  })
})

describe('McpManager — start python 运行时', () => {
  const pyRecord = (over: Partial<McpServerRecord> = {}) => makeRecord({
    id: 'pysrv',
    runtime: 'python',
    command: '/usr/bin/python3',
    pythonPackages: ['mcp-server-fetch==0.1.0'],
    ...over
  })

  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('installing → throw "Python 依赖正在安装中"', async () => {
    mocks.repoList = [pyRecord()]
    mocks.envState = { status: 'installing' }
    await expect(mgr.start('pysrv')).rejects.toThrow('Python 依赖正在安装中')
  })

  it('stale → throw "Python 虚拟环境已失效"', async () => {
    mocks.repoList = [pyRecord()]
    mocks.envState = { status: 'stale' }
    await expect(mgr.start('pysrv')).rejects.toThrow('Python 虚拟环境已失效')
  })

  it('none → throw "Python 依赖尚未安装"', async () => {
    mocks.repoList = [pyRecord()]
    mocks.envState = { status: 'none' }
    await expect(mgr.start('pysrv')).rejects.toThrow('Python 依赖尚未安装')
  })

  it('ready → 用 venvPython 启动并注入 VIRTUAL_ENV/PATH/PYTHONUNBUFFERED', async () => {
    mocks.repoList = [pyRecord()]
    mocks.envState = { status: 'ready' }
    await mgr.start('pysrv')
    expect(mocks.clients).toHaveLength(1)
    const fake1 = mocks.clients[0]!
    const env = fake1.opts.env as Record<string, string>
    expect(fake1.opts.command).toBe('/venv/pysrv/python.exe')
    expect(env.VIRTUAL_ENV).toBe('/venv/pysrv')
    expect(env.PATH).toContain('/venv/pysrv/bin')
    expect(env.PYTHONUNBUFFERED).toBe('1')
  })

  it('无 packages → 不调 getEnvState，env 注入 PYTHONIOENCODING', async () => {
    mocks.repoList = [pyRecord({ pythonPackages: [] })]
    const { pythonEnvService } = await import('../src/main/mcp/python-env')
    await mgr.start('pysrv')
    expect(pythonEnvService.getEnvState).not.toHaveBeenCalled()
    const fakeNP = mocks.clients[0]!
    const env = fakeNP.opts.env as Record<string, string>
    expect(env.PYTHONIOENCODING).toBe('utf-8')
    expect(fakeNP.opts.command).toBe('/usr/bin/python3')
  })
})

describe('McpManager — start 成功路径', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('spawn+initialize+tools/list 成功 → status running，emit starting→running，tools 转换', async () => {
    mocks.repoList = [makeRecord()]
    let reqIdx = 0
    mocks.requestImpl = async () => {
      reqIdx++
      return reqIdx === 1
        ? { protocolVersion: '2024-11-05' } // initialize
        : { tools: [{ name: 'get_user', description: '获取用户' }, { name: 'list_items' }] } // tools/list
    }
    const r = await mgr.start('srv1')
    expect(r.status).toBe('running')
    expect(r.tools).toHaveLength(2)
    // SEC-5：未显式信任的 Server，只读命名也是 confirm（名字由 Server 自报）
    expect(r.tools[0]).toMatchObject({ id: 'mcp:srv1:get_user', name: 'get_user', permission: 'confirm' })
    expect(r.tools[1]).toMatchObject({ id: 'mcp:srv1:list_items', name: 'list_items', permission: 'confirm' })
    expect(events.map((e) => e.status)).toEqual(['starting', 'running'])
  })

  it('trustReadOnly=true → 只读命名降级为 auto（显式信任才生效）', async () => {
    mocks.repoList = [makeRecord({ trustReadOnly: true })]
    let reqIdx = 0
    mocks.requestImpl = async () => {
      reqIdx++
      return reqIdx === 1
        ? { protocolVersion: '2024-11-05' }
        : { tools: [{ name: 'get_user' }, { name: 'do_thing' }] }
    }
    const r = await mgr.start('srv1')
    expect(r.tools[0]).toMatchObject({ name: 'get_user', permission: 'auto' })
    expect(r.tools[1]).toMatchObject({ name: 'do_thing', permission: 'confirm' })
  })

  it('spawn 失败 → status error，throw，client.shutdown 被调', async () => {
    mocks.repoList = [makeRecord()]
    mocks.spawnImpl = async () => { throw new Error('spawn ENOENT') }
    await expect(mgr.start('srv1')).rejects.toThrow('spawn ENOENT')
    expect(mocks.clients[0]!.shutdown).toHaveBeenCalledTimes(1)
    expect(events.at(-1)?.status).toBe('error')
    expect(events.at(-1)?.lastError).toBe('spawn ENOENT')
  })

  it('握手中已停止 → 不翻回 running，client.shutdown 被调', async () => {
    mocks.repoList = [makeRecord()]
    let reqCalls = 0
    mocks.requestImpl = async () => {
      reqCalls++
      if (reqCalls === 1) {
        // initialize 刚跑完，模拟用户在握手期点了 stop
        const runtimes = (mgr as unknown as { runtimes: Map<string, { status: string }> }).runtimes
        const entry = runtimes.get('srv1')
        if (entry) entry.status = 'stopped'
      }
      return reqCalls === 1 ? { protocolVersion: 'x' } : { tools: [] }
    }
    const r = await mgr.start('srv1')
    expect(r.status).toBe('stopped')
    expect(mocks.clients[0]!.shutdown).toHaveBeenCalledTimes(1)
    expect(events.at(-1)?.status).not.toBe('running')
  })
})

describe('McpManager — tools/list 边界收紧（防恶意/失控 server）', () => {
  /** initialize 返回 init，第二次请求（tools/list）返回 { tools } */
  function mockToolsResult(tools: unknown): void {
    let reqIdx = 0
    mocks.requestImpl = async () =>
      ++reqIdx === 1 ? { protocolVersion: '2024-11-05' } : { tools }
  }

  beforeEach(() => {
    mocks.repoList = [makeRecord()]
  })

  it('tools 不是数组（缺失）→ 拒绝启动', async () => {
    let reqIdx = 0
    mocks.requestImpl = async () => (++reqIdx === 1 ? { protocolVersion: 'x' } : {})
    await expect(mgr.start('srv1')).rejects.toThrow(/工具列表格式非法/)
  })

  it('工具数超过上限 → 拒绝启动', async () => {
    mockToolsResult(Array.from({ length: MAX_MCP_TOOLS + 1 }, (_, i) => ({ name: `tool_${i}` })))
    await expect(mgr.start('srv1')).rejects.toThrow(new RegExp(`超过上限 ${MAX_MCP_TOOLS}`))
  })

  it('工具名缺失/为空 → 拒绝启动', async () => {
    mockToolsResult([{ name: 'ok_tool' }, { description: 'no name' }])
    await expect(mgr.start('srv1')).rejects.toThrow(/第 2 个工具名称非法/)
  })

  it('工具名含非法字符（冒号）/超 64 字符 → 拒绝启动', async () => {
    mockToolsResult([{ name: 'evil:name' }])
    await expect(mgr.start('srv1')).rejects.toThrow(/工具名称非法/)
    mockToolsResult([{ name: 'a'.repeat(65) }])
    await expect(mgr.start('srv1')).rejects.toThrow(/工具名称非法/)
  })

  it('description 超长 → 截断到上限，正常启动', async () => {
    const longDesc = 'x'.repeat(MAX_MCP_TOOL_DESC_CHARS + 100)
    mockToolsResult([{ name: 'get_x', description: longDesc }])
    const r = await mgr.start('srv1')
    expect(r.status).toBe('running')
    expect(r.tools[0]!.description).toHaveLength(MAX_MCP_TOOL_DESC_CHARS)
  })

  it('inputSchema 为非对象（字符串）→ 兜底为空 schema，正常启动', async () => {
    mockToolsResult([{ name: 'get_x', inputSchema: 'not-an-object' }])
    const r = await mgr.start('srv1')
    expect(r.status).toBe('running')
    expect(r.tools[0]!.parameters).toEqual({ type: 'object', properties: {} })
  })

  it('inputSchema 序列化超 64KB → 拒绝启动', async () => {
    mockToolsResult([{ name: 'get_x', inputSchema: { pad: 'y'.repeat(MAX_MCP_TOOL_SCHEMA_CHARS + 10) } }])
    await expect(mgr.start('srv1')).rejects.toThrow(/inputSchema 超过/)
  })

  it('恰好达到工具数上限且名称合法 → 正常启动', async () => {
    mockToolsResult(Array.from({ length: MAX_MCP_TOOLS }, (_, i) => ({ name: `t${i}` })))
    const r = await mgr.start('srv1')
    expect(r.status).toBe('running')
    expect(r.tools).toHaveLength(MAX_MCP_TOOLS)
  })
})

describe('McpManager — stop / restart', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('stop 未运行 entry（有 entry 无 client）→ emit stopped，shutdown 不调', async () => {
    mocks.repoList = [makeRecord()]
    ;(mgr as unknown as { runtimes: Map<string, unknown> }).runtimes.set('srv1', {
      record: mocks.repoList[0],
      client: null,
      status: 'stopped',
      tools: [],
      lastError: null,
      autoRestarts: 0,
      logBuffer: [],
      startToken: 0,
      startPromise: null
    })
    await mgr.stop('srv1')
    expect(events.map((e) => e.status)).toEqual(['stopped'])
  })

  it('stop 已运行 → client.shutdown 被调，状态 stopped', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const fake = mocks.clients[0]!
    expect(fake.shutdown).toHaveBeenCalledTimes(0)
    await mgr.stop('srv1')
    expect(fake.shutdown).toHaveBeenCalledTimes(1)
    expect(events.at(-1)?.status).toBe('stopped')
  })

  it('restart → 先 stop 再 start（spawn 两个不同 client）', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    expect(mocks.clients).toHaveLength(1)
    await mgr.restart('srv1')
    expect(mocks.clients).toHaveLength(2)
    expect(mocks.clients[0]).not.toBe(mocks.clients[1])
  })
})

describe('McpManager — listTools / callTool', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('listTools 未运行 → throw "MCP Server 未运行"', async () => {
    await expect(mgr.listTools('srv1')).rejects.toThrow('MCP Server 未运行，请先启动')
  })

  it('callTool 未运行 → throw "MCP Server 未运行"', async () => {
    await expect(mgr.callTool('srv1', 'get_user', {})).rejects.toThrow('MCP Server 未运行')
  })

  it('callTool 已运行 → 调用 client.request("tools/call", {name,arguments})', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    // 启动完成后改 request 行为以区分 tools/call 调用
    mocks.requestImpl = async () => ({ result: 'ok' })
    const out = await mgr.callTool('srv1', 'get_x', { id: 1 })
    expect(mocks.clients[0]!.request).toHaveBeenCalledWith('tools/call', { name: 'get_x', arguments: { id: 1 } }, 30_000)
    expect(out).toEqual({ result: 'ok' })
  })
})

describe('McpManager — handleExit 自动重启', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('startToken 不匹配 → 忽略（不 emit 新状态）', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    // callOnExit 触发的 handleExit 用构造时闭包捕获的 startToken=1；
    // 手动改 entry.startToken 让其与闭包不一致，handleExit 应早 return
    const entry = (mgr as unknown as { runtimes: Map<string, { startToken: number }> }).runtimes.get('srv1')!
    entry.startToken = 999
    const before = events.length
    mocks.clients[0]!.callOnExit(0, null)
    expect(events.length).toBe(before)
  })

  it('status === stopped → 忽略（主动停止）', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const entry = (mgr as unknown as { runtimes: Map<string, { status: string; startToken: number }> }).runtimes.get('srv1')!
    entry.status = 'stopped'
    const before = events.length
    // startToken=1 与 entry.startToken 一致，但因 status=stopped 应早 return
    mocks.clients[0]!.callOnExit(1, null)
    expect(events.length).toBe(before)
  })

  it('autoRestarts < MAX → 状态 starting，emit starting，自动重启', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const entry = (mgr as unknown as { runtimes: Map<string, { autoRestarts: number; startToken: number }> }).runtimes.get('srv1')!
    entry.autoRestarts = 0
    mocks.clients[0]!.callOnExit(1, null)
    // handleExit 同步 emit 'starting' + lastError，随后 void reboot() 同步触发 doStart
    // 又 emit 一次 'starting'（无 lastError）。用 filter 捕获带错误的重启事件
    const restartEvents = events.filter((e) => e.lastError?.includes('第 1 次自动重启'))
    expect(restartEvents).toHaveLength(1)
    expect(restartEvents[0]!.status).toBe('starting')
    // 等异步 start 完成
    await vi.waitFor(() => {
      expect(events.at(-1)?.status).toBe('running')
    })
    expect(mocks.clients).toHaveLength(2)
  })

  it('autoRestarts === MAX → 状态 error，emit error，不再重启', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const entry = (mgr as unknown as { runtimes: Map<string, { autoRestarts: number; startToken: number }> }).runtimes.get('srv1')!
    entry.autoRestarts = 3
    mocks.clients[0]!.callOnExit(1, null)
    expect(events.at(-1)?.status).toBe('error')
    expect(events.at(-1)?.lastError).toContain('已达自动重启上限')
    expect(mocks.clients).toHaveLength(1)
  })
})

describe('describeStartupExit — 启动即退出的原因文案', () => {
  it('没有 stderr 行时只给退出码/信号', () => {
    expect(describeStartupExit(1, null, [])).toBe('进程启动后立即退出 (code=1, signal=null)')
    expect(describeStartupExit(null, 'SIGKILL', ['[stdout] 无关行'])).toContain('signal=SIGKILL')
  })

  it('按关键词挑行：E404 那行必须在，npm 的客套话不该进来（真机推翻过纯取尾部）', () => {
    const buf = [
      '[stderr] npm error code E404',
      '[stderr] npm error 404 Not Found - GET https://registry.npmjs.org/nope-xyz - Not found',
      '[stderr] npm error 404',
      '[stderr] npm error 404 Note that you can also install from a',
      '[stderr] npm error 404 tarball, folder, http url, or git url.',
      '[stderr] npm error A complete log of this run can be found in: C:\\npm-cache\\_logs\\debug-0.log'
    ]
    const msg = describeStartupExit(1, null, buf)
    expect(msg).toContain('npm error code E404')
    expect(msg).toContain('nope-xyz')
    // 取的是最早命中的 3 行，而不是把客套话与日志路径那几行挤进来
    expect(msg).not.toContain('Note that you can also install')
    expect(msg).not.toContain('A complete log of this run')
    expect(msg.length).toBeLessThanOrEqual(120 + 300)
  })

  it('命中的行里照样脱敏；一行关键词都不命中时退回最后一行（不留空消息）', () => {
    const redacted = describeStartupExit(1, null, [
      '[stderr] 连接失败 token=sk-abcdefghijklmnopqrstuvwxyz012345'
    ])
    expect(redacted).toContain('失败')
    expect(redacted).toContain('[redacted]')
    expect(redacted).not.toContain('sk-abcdefghijklmnop')

    const fallback = describeStartupExit(2, 'SIGTERM', ['[stderr] 一切平常', '[stderr] 最后一行输出'])
    expect(fallback).toContain('signal=SIGTERM')
    expect(fallback).toContain('最后一行输出')
    expect(fallback).not.toContain('一切平常')
  })

  it('超长单行先各自截断，不把整坨巨串喂给脱敏正则', () => {
    const huge = 'x'.repeat(200_000)
    const msg = describeStartupExit(1, null, [`[stderr] ${huge}`])
    expect(msg).not.toContain('x'.repeat(300))
    expect(msg.length).toBeLessThan(600)
  })
})

describe('McpManager — 启动即退出（从未 running 过）不自动重启', () => {
  it('握手阶段进程就退出：直接 error，不再 spawn 第二遍', async () => {
    mocks.requestImpl = async (method: unknown) => {
      if (method === 'initialize') {
        const c = mocks.clients[0]!
        c.callOnLog('stderr', 'npm error code E404')
        c.callOnLog('stderr', 'npm error 404 Not Found - @modelcontextprotocol/nope-xyz')
        // 真实时序：子进程 exit 回调先同步跑完，握手 promise 随后才 reject
        c.callOnExit(1, null)
        throw new Error('MCP 进程退出 (code=1, signal=null)')
      }
      return { tools: [] }
    }
    mocks.repoList = [makeRecord()]
    await expect(mgr.start('srv1')).rejects.toThrow('进程退出')
    // 核心：必然失败的启动不再被当崩溃重播 4 遍
    expect(mocks.clients).toHaveLength(1)
    expect(events.some((e) => e.lastError?.includes('自动重启'))).toBe(false)
    const last = events.at(-1)!
    expect(last.status).toBe('error')
    expect(last.lastError).toContain('进程启动后立即退出 (code=1')
    expect(last.lastError).toContain('E404')
  })

  it('catch 不覆盖 handleExit 记下的原因（否则退化成没用的「进程退出」）', async () => {
    mocks.requestImpl = async (method: unknown) => {
      if (method === 'initialize') {
        mocks.clients[0]!.callOnLog('stderr', 'npm error code E404')
        mocks.clients[0]!.callOnExit(1, null)
        throw new Error('MCP 进程退出 (code=1, signal=null)')
      }
      return { tools: [] }
    }
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1').catch(() => undefined)
    const errs = events.filter((e) => e.status === 'error')
    expect(errs.length).toBe(1) // 只 emit 一次 error，catch 不重复覆盖
    expect(errs[0]!.lastError).toContain('E404')
  })

  it('反向保护：握手超时但进程还活着，catch 仍要自己兜住转 error', async () => {
    mocks.requestImpl = async (method: unknown) => {
      if (method === 'initialize') throw new Error('JSON-RPC 请求超时: initialize (15000ms)')
      return { tools: [] }
    }
    mocks.repoList = [makeRecord()]
    await expect(mgr.start('srv1')).rejects.toThrow('超时')
    const last = events.at(-1)!
    expect(last.status).toBe('error')
    expect(last.lastError).toContain('initialize')
  })
})

describe('startupFailureHint — 超时要说下一步', () => {
  it('只给「请求超时」加提示，其他原因原样返回', () => {
    expect(startupFailureHint('JSON-RPC 请求超时: initialize (60000ms)')).toContain('可稍后再点一次启动')
    expect(startupFailureHint('MCP 进程退出 (code=1, signal=null)')).toBe('MCP 进程退出 (code=1, signal=null)')
  })
})

describe('McpManager — 握手超时按传输分层（#41：npx 首次下载依赖）', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('stdio：initialize 与 tools/list 都拿到 60s（冷缓存装依赖本机实测 24.6s + 下载 3.2s）', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const timeouts = mocks.clients[0]!.request.mock.calls.map((c: unknown[]) => c[2])
    expect(timeouts).toEqual([60_000, 60_000])
  })

  it('http：仍守 15s —— 远端本该秒回，放宽只会拖慢「地址或鉴权写错」的暴露', async () => {
    mocks.repoList = [makeRecord({ transport: 'http', url: 'https://example.com/mcp', command: null })]
    await mgr.start('srv1')
    const timeouts = mocks.clients[0]!.request.mock.calls.map((c: unknown[]) => c[2])
    expect(timeouts).toEqual([15_000, 15_000])
  })

  it('超时后 lastError 带下一步，而不是只有一句「超时」', async () => {
    mocks.requestImpl = async (method: unknown) => {
      if (method === 'initialize') throw new Error('JSON-RPC 请求超时: initialize (60000ms)')
      return { tools: [] }
    }
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1').catch(() => undefined)
    const last = events.at(-1)!
    expect(last.status).toBe('error')
    expect(last.lastError).toContain('首次通过 npx 启动需现下载依赖')
  })
})

describe('McpManager — handleLog 与订阅', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('handleLog 写入 logBuffer，emit log 事件，超 LOG_BUFFER_SIZE shift', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const logEvents: Array<{ stream: string; line: string }> = []
    mgr.onLog((e) => logEvents.push({ stream: e.stream, line: e.line }))
    const fake = mocks.clients[0]!
    // 推 210 行（> LOG_BUFFER_SIZE=200）
    for (let i = 0; i < 210; i++) {
      fake.callOnLog('stdout', `line ${i}`)
    }
    expect(logEvents).toHaveLength(210)
    expect(logEvents[0]!.line).toBe('line 0')
    // entry.logBuffer 应只保留最后 200 条
    const entry = (mgr as unknown as { runtimes: Map<string, { logBuffer: string[] }> }).runtimes.get('srv1')!
    expect(entry.logBuffer).toHaveLength(200)
    expect(entry.logBuffer[0]).toContain('line 10')
    expect(entry.logBuffer.at(-1)).toContain('line 209')
  })

  it('onStatus/onLog 返回取消订阅函数，调用后不再收事件', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1') // emit starting + running
    const localEvents: McpServerStatusEvent[] = []
    const off = mgr.onStatus((e) => localEvents.push(e))
    off()
    await mgr.stop('srv1') // emit stopped
    expect(localEvents).toHaveLength(0)
  })
})

describe('McpManager — 稳定运行复位', () => {
  beforeEach(() => {
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('STABLE_RUNNING_MS 后 autoRestarts 复位为 0', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const entry = (mgr as unknown as { runtimes: Map<string, { autoRestarts: number }> }).runtimes.get('srv1')!
    entry.autoRestarts = 2
    // 推进 5 分钟 + 1ms 触发 stableTimer
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(entry.autoRestarts).toBe(0)
  })
})

describe('McpManager — callTool HTTP 断线自动重连（重试一次，仍失败才置 error）', () => {
  /** 取运行时 entry（测试辅助 cast） */
  function getEntry(): { status: string; lastError: string | null } {
    return (mgr as unknown as {
      runtimes: Map<string, { status: string; lastError: string | null }>
    }).runtimes.get('srv1')!
  }

  it('HTTP 传输级错误 → 自动重连 + 透明重试成功，状态保持 running', async () => {
    mocks.repoList = [makeRecord({ transport: 'http', url: 'https://example.com/mcp' })]
    mocks.requestImpl = async (method) =>
      method === 'tools/list' ? { tools: [] } : method === 'initialize' ? { protocolVersion: 'x' } : { result: 'ok' }
    await mgr.start('srv1')
    expect(mocks.clients).toHaveLength(1)

    // 仅旧 client 的 tools/call 失败（模拟连接断开）；重连后的新 client 走 requestImpl
    mocks.clients[0]!.request.mockImplementation(async (method: string) => {
      if (method === 'tools/call') throw new McpTransportError('network', 'fetch failed')
      throw new Error(`未预期的请求: ${method}`)
    })

    const out = await mgr.callTool('srv1', 'get_x', { a: 1 })
    expect(out).toEqual({ result: 'ok' })
    // 重连 = stop + start：新建第二个 client 并完整握手
    expect(mocks.clients).toHaveLength(2)
    expect(mocks.clients[0]!.shutdown).toHaveBeenCalled()
    expect(getEntry().status).toBe('running')
    // 重连期间 emit starting → running（初始启动 1 次 + 重连 1 次）
    expect(events.filter((e) => e.status === 'starting')).toHaveLength(2)
    expect(events.at(-1)?.status).toBe('running')
    // 重试打在新 client 上，参数原样透传
    expect(mocks.clients[1]!.request).toHaveBeenCalledWith('tools/call', { name: 'get_x', arguments: { a: 1 } }, 30_000)
  })

  it('HTTP 重连后重试仍失败 → status error + emit + throw', async () => {
    mocks.repoList = [makeRecord({ transport: 'http', url: 'https://example.com/mcp' })]
    mocks.requestImpl = async (method) => {
      if (method === 'tools/call') throw new McpTransportError('network', 'fetch failed')
      if (method === 'tools/list') return { tools: [] }
      return { protocolVersion: 'x' }
    }
    await mgr.start('srv1')

    await expect(mgr.callTool('srv1', 'get_x', {})).rejects.toThrow('fetch failed')
    // 重连发生过（新 client 建立且握手成功），但重试的 tools/call 再次失败
    expect(mocks.clients).toHaveLength(2)
    expect(getEntry().status).toBe('error')
    expect(getEntry().lastError).toBe('fetch failed')
    expect(events.at(-1)).toMatchObject({ status: 'error', lastError: 'fetch failed' })

    // error 状态必须经 restart 恢复：callTool 直接被守门拒绝
    await expect(mgr.callTool('srv1', 'get_x', {})).rejects.toThrow('MCP Server 未运行')
  })

  it('HTTP 非传输级错误（普通 Error，如工具执行失败）→ 不重连，保持 running', async () => {
    mocks.repoList = [makeRecord({ transport: 'http', url: 'https://example.com/mcp' })]
    mocks.requestImpl = async (method) => {
      if (method === 'tools/call') throw new Error('tool boom')
      if (method === 'tools/list') return { tools: [] }
      return { protocolVersion: 'x' }
    }
    await mgr.start('srv1')

    await expect(mgr.callTool('srv1', 'get_x', {})).rejects.toThrow('tool boom')
    expect(getEntry().status).toBe('running')
    expect(mocks.clients).toHaveLength(1)
  })

  it('stdio 即使抛 McpTransportError 也不重连（进程死亡由 handleExit 收口）', async () => {
    mocks.repoList = [makeRecord()]
    mocks.requestImpl = async (method) => {
      if (method === 'tools/call') throw new McpTransportError('timeout', '慢请求')
      if (method === 'tools/list') return { tools: [] }
      return { protocolVersion: 'x' }
    }
    await mgr.start('srv1')

    await expect(mgr.callTool('srv1', 'get_x', {})).rejects.toThrow('慢请求')
    expect(getEntry().status).toBe('running')
    expect(mocks.clients).toHaveLength(1)
  })
})

describe('McpManager — 调用记录事件（onCall）', () => {
  beforeEach(async () => {
    mocks.requestImpl = async () => ({ tools: [] })
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    // 启动完成后改 request 行为，区分 tools/call
    mocks.requestImpl = async () => ({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('成功调用 → 发一条 ok 事件，带耗时与入参/结果预览，返回值原样透出', async () => {
    const calls: McpCallEvent[] = []
    mgr.onCall((e) => calls.push(e))
    const out = await mgr.callTool('srv1', 'fetch', { url: 'https://a.test' })
    expect(out).toEqual({ content: [{ type: 'text', text: 'ok' }] })
    expect(calls).toHaveLength(1)
    const e = calls[0]!
    expect(e.serverId).toBe('srv1')
    expect(e.tool).toBe('fetch')
    expect(e.ok).toBe(true)
    expect(e.error).toBeNull()
    expect(e.durationMs).toBeGreaterThanOrEqual(0)
    expect(e.argsPreview).toContain('url=')
    expect(e.resultPreview).toBe('ok')
  })

  it('server 正常响应但带 isError → 记为失败，结果照旧返回给调用方', async () => {
    mocks.requestImpl = async () => ({ content: [{ type: 'text', text: '额度不足' }], isError: true })
    const calls: McpCallEvent[] = []
    mgr.onCall((e) => calls.push(e))
    const out = await mgr.callTool('srv1', 'fetch', {})
    expect(out).toMatchObject({ isError: true })
    expect(calls[0]!.ok).toBe(false)
    expect(calls[0]!.resultPreview).toBe('额度不足')
  })

  it('传输层抛错 → 记一条失败事件并把原异常继续抛出（不吞错）', async () => {
    mocks.requestImpl = async () => {
      throw new Error('connection reset')
    }
    const calls: McpCallEvent[] = []
    mgr.onCall((e) => calls.push(e))
    await expect(mgr.callTool('srv1', 'fetch', { a: 1 })).rejects.toThrow('connection reset')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ok).toBe(false)
    expect(calls[0]!.error).toContain('connection reset')
  })

  it('未运行的调用同样记一条失败事件（试运行最常见的错因就是它，不能静默）', async () => {
    const calls: McpCallEvent[] = []
    mgr.onCall((e) => calls.push(e))
    await expect(mgr.callTool('nope', 'fetch', {})).rejects.toThrow('MCP Server 未运行')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.ok).toBe(false)
    expect(calls[0]!.error).toContain('未运行')
  })

  it('取消订阅后不再收到事件（避免注册泄漏）', async () => {
    const calls: McpCallEvent[] = []
    const off = mgr.onCall((e) => calls.push(e))
    off()
    await mgr.callTool('srv1', 'fetch', {})
    expect(calls).toHaveLength(0)
  })
})

// ---------- §314：forget ＝ 停＋把运行时 entry 摘掉（删除服务器走这条） ----------
describe('McpManager — §314 删除不许只 stop：entry 与它带的凭据要一起消失', () => {
  let logEvents: Array<{ serverId: string; line: string }>

  beforeEach(() => {
    logEvents = []
    mgr.onLog((e) => logEvents.push({ serverId: e.serverId, line: e.line }))
    // 握手两发（initialize / tools/list）都要过，才有"正在跑"的 entry 可摘
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('正向对照：只 stop 时，垂死子进程后到的一行 stderr 仍会推给这个 serverId', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const client = mocks.clients[0]!
    await mgr.stop('srv1')
    logEvents.length = 0
    client.callOnLog('stderr', 'shutdown 前最后吐的一行')
    expect(logEvents.filter((e) => e.serverId === 'srv1').map((e) => e.line))
      .toContain('shutdown 前最后吐的一行')
  })

  it('forget 之后：同一条 client 再吐一行、再报一次退出，日志与状态流都不许再有它', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const client = mocks.clients[0]!
    await mgr.forget('srv1')
    events.length = 0
    logEvents.length = 0
    client.callOnLog('stderr', '迟到的日志行')
    client.callOnExit(1, null)
    expect(logEvents, 'entry 已摘 ⇒ handleLog 该直接回').toEqual([])
    expect(events, 'handleExit 也因 entry 不在而什么都不发（不给已删除的配置自动重启）').toEqual([])
    // 顺序判据：stop 必须在摘 entry 之前真正执行到 client.shutdown。
    // 反过来写（先 delete 再 stop）时这两行断言照样绿——进程却留在机器上。
    expect(client.shutdown, 'forget 要把子进程真关掉，不是只把登记抹掉').toHaveBeenCalled()
  })

  it('反向对照：forget 只摘它那一条，另一条在跑的服务器不受影响（防"整张清掉"这种过度修复）', async () => {
    mocks.repoList = [makeRecord({ id: 'srv1' }), makeRecord({ id: 'srv2', name: 'other-srv' })]
    await mgr.start('srv1')
    await mgr.start('srv2')
    expect(mocks.clients).toHaveLength(2)
    await mgr.forget('srv1')
    logEvents.length = 0
    mocks.clients[1]!.callOnLog('stderr', 'srv2 还活着')
    expect(logEvents.map((e) => `${e.serverId}:${e.line}`)).toEqual(['srv2:srv2 还活着'])
  })

  it('forget 对没见过的 id 是幂等的（不该抛，也不该发事件）', async () => {
    events.length = 0
    await expect(mgr.forget('nope')).resolves.toBeUndefined()
    expect(events).toEqual([])
  })
})

// ---------- §315：配置被整批换掉之后（合并／恢复），按身份字段对账 ----------
describe('McpManager — §315 reconcileRuntimes 只摘"已经不是那条记录的那个进程"', () => {
  let logLines: string[]

  beforeEach(() => {
    // 握手两发（initialize / tools/list）都要过，才有"正在跑"的 entry 可对账
    mocks.requestImpl = async () => ({ tools: [] })
    logLines = []
    mgr.onLog((e) => logLines.push(`${e.serverId}:${e.line}`))
  })

  it('正向对照：库里那份一模一样 ⇒ 一台都不许停', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const client = mocks.clients[0]!
    expect(await mgr.reconcileRuntimes()).toEqual([])
    expect(client.shutdown, '没变化却杀进程＝过度修复').not.toHaveBeenCalled()
    client.callOnLog('stderr', '还在跑')
    expect(logLines).toEqual(['srv1:还在跑'])
  })

  it('只改了名字与 enabled ⇒ 不许停（那几列不改变"这个进程是什么"）', async () => {
    mocks.repoList = [makeRecord({ env: { TOKEN: 'a' } })]
    await mgr.start('srv1')
    mocks.repoList = [makeRecord({ name: '换了个名', enabled: false, createdAt: 9, env: { TOKEN: 'a' } })]
    expect(await mgr.reconcileRuntimes()).toEqual([])
  })

  it('记录整条没了 ⇒ 摘掉，且子进程真被关掉', async () => {
    mocks.repoList = [makeRecord()]
    await mgr.start('srv1')
    const client = mocks.clients[0]!
    mocks.repoList = []
    expect(await mgr.reconcileRuntimes()).toEqual(['srv1'])
    expect(client.shutdown).toHaveBeenCalled()
    logLines.length = 0
    client.callOnLog('stderr', '迟到的行')
    expect(logLines, 'entry 已摘 ⇒ 不该再推日志').toEqual([])
  })

  it('云端把「信任只读工具」关掉 ⇒ 必须摘（工具列表里的权限分级是启动那一刻烤进去的）', async () => {
    mocks.repoList = [makeRecord({ trustReadOnly: true })]
    await mgr.start('srv1')
    mocks.repoList = [makeRecord({ trustReadOnly: false })]
    expect(await mgr.reconcileRuntimes()).toEqual(['srv1'])
  })

  it('command 与 args 换了 ⇒ 摘；args 只是顺序变了也摘（argv 顺序有意义）', async () => {
    mocks.repoList = [makeRecord({ args: ['--stdio', 'a'] })]
    await mgr.start('srv1')
    mocks.repoList = [makeRecord({ args: ['a', '--stdio'] })]
    expect(await mgr.reconcileRuntimes()).toEqual(['srv1'])
  })

  it('env 只是键序不同、值一模一样 ⇒ 不许摘（否则合并会集体误停机）', async () => {
    mocks.repoList = [makeRecord({ env: { A: '1', B: '2' }, headers: { X: 'x' } })]
    await mgr.start('srv1')
    mocks.repoList = [makeRecord({ env: { B: '2', A: '1' }, headers: { X: 'x' } })]
    expect(await mgr.reconcileRuntimes()).toEqual([])
  })

  it('两条在跑的只摘该摘的那一条（另一条不受影响）', async () => {
    mocks.repoList = [makeRecord({ id: 'srv1' }), makeRecord({ id: 'srv2', name: 'other-srv' })]
    await mgr.start('srv1')
    await mgr.start('srv2')
    mocks.repoList = [makeRecord({ id: 'srv2' })] // srv1 那条被云端删了
    expect(await mgr.reconcileRuntimes()).toEqual(['srv1'])
    logLines.length = 0
    mocks.clients[1]!.callOnLog('stderr', 'srv2 照旧')
    expect(logLines).toEqual(['srv2:srv2 照旧'])
  })
})

// ---------- §317：createClient 那次 await 期间被删除 ⇒ 不许写回 map、不许拉起进程 ----------
describe('McpManager — §317 启动与删除交错：写回 entry 之前要现查记录还在不在', () => {
  let logLines: string[]

  beforeEach(() => {
    logLines = []
    mgr.onLog((e) => logLines.push(`${e.serverId}:${e.line}`))
    mocks.requestImpl = async () => ({ tools: [] })
  })

  it('删除落在 createClient 的 await 里 ⇒ start 抛「不存在」、一次都不 spawn、map 里没写回', async () => {
    mocks.repoList = [makeRecord()]
    const started = mgr.start('srv1') // 同步跑到 createClient 那次 await 就把控制权交还
    mocks.repoList = [] // 真链里删除是一条独立的 IPC 宏任务，正好在这一次 await 期间走完
    await expect(started).rejects.toThrow('MCP Server 不存在: srv1')
    expect(mocks.clients).toHaveLength(1) // client 已按原样造出来（那次 await 的代价）
    expect(mocks.clients[0]!.spawn, '中止必须发生在拉起进程之前').not.toHaveBeenCalled()
    expect(events.map((e) => `${e.serverId}:${e.status}`), '不许给已删除的 id 推 starting').toEqual([])
    // 「没写回 map」的可观测证据：stopAll 循不到它 ⇒ 不会有任何 stopped 事件、也不会去关那颗 client
    await mgr.stopAll()
    expect(events).toEqual([])
    expect(mocks.clients[0]!.shutdown).not.toHaveBeenCalled()
    expect(logLines).toEqual([])
  })

  it('窗口再宽一点（删除落在 spawn 之后、握手期间）：既有那颗「已停止」守卫负责关进程、状态不许翻 running', async () => {
    // 这一条不新增机关，它钉的是"为什么只需要上面那一个检查点"：那时 entry 已在 map 里，
    // forget→stop 会把它标成 stopped，doStart 回来时那颗守卫就有牙（我把新检查点挪到写回之后，
    // 靠的就是这一条还在守着——所以它必须有用例点名，不能只写在注释里）。
    mocks.repoList = [makeRecord()]
    let releaseSpawn!: () => void
    mocks.spawnImpl = () =>
      new Promise<void>((r) => {
        releaseSpawn = r
      })
    const started = mgr.start('srv1')
    // 等状态，不等时长：直到 doStart 真卡在 spawn 上
    for (let i = 0; i < 50 && mocks.clients[0]?.spawn.mock.calls.length === 0; i++) {
      await vi.advanceTimersByTimeAsync(0)
    }
    mocks.repoList = []
    await mgr.forget('srv1')
    expect(mocks.clients[0]!.shutdown, '此刻 stop 还看不到 client，不该也不能关进程').not.toHaveBeenCalled()
    events.length = 0
    releaseSpawn()
    await started
    expect(mocks.clients[0]!.shutdown, '握手回来发现自己已被摘走 ⇒ 关掉刚拉起的进程').toHaveBeenCalled()
    expect(events.filter((e) => e.status === 'running'), '别把 running 与工具清单写给已删除的 id').toEqual([])
  })
})
