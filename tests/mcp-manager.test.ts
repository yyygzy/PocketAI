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
import type { McpServerRecord, McpServerStatusEvent } from '../src/shared/types'

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
  spawnImpl: (async () => {}) as () => Promise<void>,
  requestImpl: (async () => ({})) as () => Promise<unknown>,
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
        request: vi.fn(() => mocks.requestImpl()),
        notify: vi.fn(),
        shutdown: vi.fn(async () => {}),
        callOnLog: opts.onLog as (s: 'stdout' | 'stderr', l: string) => void,
        callOnExit: opts.onExit as (c: number | null, s: NodeJS.Signals | null) => void
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

import { McpManager } from '../src/main/mcp/manager'

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
    enabled: true,
    createdAt: 0,
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
    resolveSpawn()
    // 让后续 initialize / tools/list 走默认 requestImpl 返回 {} —— 但 start 需要 tools 字段
    // 所以恢复默认 requestImpl 让其返回 { tools: [] }
    mocks.requestImpl = async () => ({ tools: [] })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.status).toBe('running')
    expect(r2).toBe(r1)
  })

  it('HTTP transport → throw "v1 暂不支持 HTTP"', async () => {
    mocks.repoList = [makeRecord({ transport: 'http' })]
    await expect(mgr.start('srv1')).rejects.toThrow('v1 暂不支持 HTTP')
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
        : { tools: [{ name: 'get_user', description: '获取用户' }, { description: 'no name' }] } // tools/list
    }
    const r = await mgr.start('srv1')
    expect(r.status).toBe('running')
    expect(r.tools).toHaveLength(2)
    expect(r.tools[0]).toMatchObject({ id: 'mcp:srv1:get_user', name: 'get_user', permission: 'auto' })
    // 第二个无 name → 'unknown'，命中危险词不命中只读前缀 → confirm
    expect(r.tools[1]).toMatchObject({ name: 'unknown', permission: 'confirm' })
    expect(events.map((e) => e.status)).toEqual(['starting', 'running'])
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
