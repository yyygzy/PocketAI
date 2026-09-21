// MCP Server 生命周期管理（M4.1）
// 基于 StdioJsonRpcClient 实现：spawn → initialize 握手 → tools/list → tools/call → shutdown
import { EventEmitter } from 'node:events'
import path from 'node:path'
import fs from 'node:fs'
import { StdioJsonRpcClient } from './json-rpc'
import { mcpServerRepo } from '../db/repositories/mcp-server.repo'
import { MCP_EXTENSIONS_DIR } from '../portable'
import { pythonEnvService, venvPython, venvDir, venvBinDir } from './python-env'
import type {
  McpServerRecord,
  McpServerRuntime,
  McpServerStatus,
  McpServerStatusEvent,
  McpServerLogEvent,
  ToolSchema
} from '../../shared/types'

const MCP_PROTOCOL_VERSION = '2024-11-05'

/** 工具调用超时 30s */
const TOOL_CALL_TIMEOUT = 30_000
/** 单次启动 initialize 握手超时 */
const INIT_TIMEOUT = 15_000
/** 进程退出后自动重启最大次数 */
const MAX_AUTO_RESTART = 3

/**
 * MCP 工具默认权限分级（基于工具名语义启发式）。
 * 原则：保守默认 confirm，仅对明显只读的命名模式放行（auto），危险关键词强制 confirm。
 * 注意：工具名可由 MCP Server 任意指定，此分级仅作为默认值；最终以助手 toolPermissions 为准。
 */
const MCP_READONLY_PREFIXES = [
  'get', 'list', 'read', 'search', 'find', 'fetch', 'query',
  'describe', 'show', 'status', 'info', 'check', 'ping',
  'time', 'date', 'version', 'whoami', 'echo', 'help'
]
const MCP_DANGEROUS_KEYWORDS = [
  'delete', 'remove', 'rm', 'drop', 'truncate', 'exec', 'execute',
  'run', 'write', 'create', 'update', 'modify', 'edit', 'send',
  'post', 'upload', 'install', 'uninstall', 'kill', 'stop',
  'restart', 'shutdown', 'format', 'reboot', 'wipe', 'destroy',
  'move', 'rename', 'chmod', 'chown', 'sudo', 'eval'
]

export function classifyMcpToolPermission(name: string): 'auto' | 'confirm' {
  const lower = (name ?? '').toLowerCase()
  // 危险关键词命中 → 必须人工确认
  if (MCP_DANGEROUS_KEYWORDS.some((kw) => lower.includes(kw))) return 'confirm'
  // 只读前缀命中 → 自动放行
  if (MCP_READONLY_PREFIXES.some((p) => lower.startsWith(p))) return 'auto'
  // 未知语义 → 保守 confirm
  return 'confirm'
}

interface RuntimeEntry {
  record: McpServerRecord
  client: StdioJsonRpcClient | null
  status: McpServerStatus
  tools: ToolSchema[]
  lastError: string | null
  autoRestarts: number
  logBuffer: string[] // 最近的 stderr 日志（环形）
  startToken: number // 启动 token，用于异步竞争保护
  startPromise: Promise<McpServerRuntime> | null // 进行中的启动（并发去重，防重复 spawn 孤儿进程）
  stableTimer?: NodeJS.Timeout // 稳定运行 N 分钟后复位 autoRestarts 计数器
}

/** 稳定运行阈值：超过该时长未崩溃则视为稳定，复位 autoRestarts */
const STABLE_RUNNING_MS = 5 * 60 * 1000

const LOG_BUFFER_SIZE = 200

class McpManager extends EventEmitter {
  private runtimes = new Map<string, RuntimeEntry>()
  /** 启动中的 in-flight Promise（同步登记，早于任何 await，并发 start 直接复用） */
  private startingPromises = new Map<string, Promise<McpServerRuntime>>()

  /** 列出所有持久化记录（不含运行时状态） */
  listRecords(): McpServerRecord[] {
    return mcpServerRepo.list()
  }

  getRecord(id: string): McpServerRecord | null {
    return mcpServerRepo.get(id)
  }

  /** 列出所有运行时状态（前端订阅用） */
  listRuntimes(): McpServerRuntime[] {
    return mcpServerRepo.list().map((r) => this.toRuntime(r))
  }

  private toRuntime(r: McpServerRecord): McpServerRuntime {
    const entry = this.runtimes.get(r.id)
    return {
      ...r,
      status: entry?.status ?? 'stopped',
      tools: entry?.tools ?? [],
      lastError: entry?.lastError ?? null,
      pid: entry?.client?.pid
    }
  }

  /** 启动 MCP Server：并发调用自动去重（spawn → initialize 握手 → tools/list） */
  async start(id: string): Promise<McpServerRuntime> {
    const record = mcpServerRepo.get(id)
    if (!record) throw new Error(`MCP Server 不存在: ${id}`)

    // 已运行则跳过
    const existing = this.runtimes.get(id)
    if (existing && existing.client && existing.status === 'running') {
      return this.toRuntime(record)
    }
    // 启动进行中：复用同一个 Promise。否则连点会在 await 间隙各 spawn 一个进程，
    // 后一个 entry 覆盖 map，先 spawn 的进程变成无人跟踪的孤儿
    const inflight = this.startingPromises.get(id)
    if (inflight) return inflight

    const promise = this.doStart(id, record, existing ?? null)
    // 同步登记（doStart 内首个 await 之前的代码也同步执行，但 map 在此刻已可见）
    this.startingPromises.set(id, promise)
    try {
      return await promise
    } finally {
      this.startingPromises.delete(id)
    }
  }

  private async doStart(
    id: string,
    record: McpServerRecord,
    existing: RuntimeEntry | null
  ): Promise<McpServerRuntime> {
    if (record.transport === 'http') {
      // v1 不实现 HTTP transport，留待 v2
      throw new Error('v1 暂不支持 HTTP 传输的 MCP Server')
    }

    if (!record.command) throw new Error('缺少 stdio command')

    // 准备 cwd：优先 extensions/mcp/{serverId}/
    const serverCwd = path.join(MCP_EXTENSIONS_DIR, record.id)
    if (!fs.existsSync(serverCwd)) {
      fs.mkdirSync(serverCwd, { recursive: true })
    }

    // 根据运行时类型准备 command / args / env
    // - binary：record.command 即可执行文件，原样启动
    // - node：record.command 通常为 node 可执行路径，args 为脚本，原样启动
    // - python（声明了依赖）：必须先在编辑页把依赖装进独立 venv；启动改用 venv 解释器，
    //   注入 VIRTUAL_ENV 并把 venv 可执行目录前置到 PATH（console-script 子进程也走 venv）
    // - python（未声明依赖，脚本/自备环境模式）：直接用 record.command，兼容旧用法
    const runtime = record.runtime ?? 'binary'
    let spawnCommand = record.command
    let spawnArgs = record.args ?? []
    const baseEnv: Record<string, string> = { ...process.env, ...(record.env ?? {}) } as Record<string, string>
    if (runtime === 'python') {
      const packages = record.pythonPackages ?? []
      if (packages.length > 0) {
        const envState = await pythonEnvService.getEnvState(record)
        if (envState.status === 'installing') {
          throw new Error('Python 依赖正在安装中，请等待安装完成后再启动')
        }
        if (envState.status !== 'ready') {
          if (envState.status === 'stale') {
            throw new Error('Python 虚拟环境已失效（可能更换了盘符或解释器），请在编辑页重新安装依赖后再启动')
          }
          throw new Error('Python 依赖尚未安装，请先在编辑页点击「安装依赖」，完成后再启动')
        }
        spawnCommand = venvPython(id)
        Object.assign(baseEnv, {
          VIRTUAL_ENV: venvDir(id),
          PATH: `${venvBinDir(id)}${path.delimiter}${baseEnv.PATH ?? ''}`
        })
      }
      Object.assign(baseEnv, {
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        PYTHONUNBUFFERED: '1'
      })
    }

    const startToken = (existing?.startToken ?? 0) + 1
    const entry: RuntimeEntry = {
      record,
      client: null,
      status: 'starting',
      tools: [],
      lastError: null,
      autoRestarts: existing?.autoRestarts ?? 0,
      logBuffer: existing?.logBuffer ?? [],
      startToken,
      startPromise: null
    }
    this.runtimes.set(id, entry)
    this.emitStatus(id, 'starting')

    const client = new StdioJsonRpcClient({
      command: spawnCommand,
      args: spawnArgs,
      env: baseEnv,
      cwd: serverCwd,
      requestTimeout: TOOL_CALL_TIMEOUT,
      onLog: (stream, line) => this.handleLog(id, stream, line),
      onExit: (code, signal) => this.handleExit(id, code, signal, startToken)
    })

    try {
      await client.spawn()
      entry.client = client

      // initialize 握手
      const initResult = await client.request<any>(
        'initialize',
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'PocketAI', version: '0.1.0' }
        },
        INIT_TIMEOUT
      )
      // 兼容 server 返回的 protocolVersion（v1 不强制校验版本一致性）
      void initResult

      // initialized 通知
      client.notify('notifications/initialized')

      // 拉取工具列表
      const toolsResult = await client.request<{ tools: any[] }>('tools/list', {}, INIT_TIMEOUT)
      entry.tools = (toolsResult?.tools ?? []).map((t) => this.normalizeMcpTool(t, id))
      // 握手期间用户已点停止：不要把状态翻回 running，关掉刚起的进程
      if (entry.status === 'stopped') {
        client.shutdown().catch(() => {})
        return this.toRuntime(record)
      }
      entry.status = 'running'
      entry.lastError = null
      // 稳定运行 STABLE_RUNNING_MS 后复位自动重启计数（崩溃循环才会累计，稳定运行后清零）
      clearTimeout(entry.stableTimer)
      entry.stableTimer = setTimeout(() => {
        entry.autoRestarts = 0
      }, STABLE_RUNNING_MS)
      this.emitStatus(id, 'running')
      return this.toRuntime(record)
    } catch (e) {
      entry.client = null
      // 出错时关闭进程（如果已 spawn）
      client.shutdown().catch(() => {})
      // 已被 stop 标记的不再回 error（保持 stopped），但异常仍抛给等待方
      if (entry.status !== 'stopped') {
        entry.status = 'error'
        entry.lastError = (e as Error).message
        this.emitStatus(id, 'error', entry.lastError)
      }
      throw e
    }
  }

  /** 停止 MCP Server */
  async stop(id: string): Promise<void> {
    const entry = this.runtimes.get(id)
    if (!entry || !entry.client) {
      if (entry) {
        entry.status = 'stopped'
        this.emitStatus(id, 'stopped')
      }
      return
    }
    const client = entry.client
    entry.client = null
    entry.status = 'stopped'
    entry.tools = []
    clearTimeout(entry.stableTimer)
    entry.stableTimer = undefined
    this.emitStatus(id, 'stopped')
    await client.shutdown().catch(() => {})
  }

  async restart(id: string): Promise<McpServerRuntime> {
    await this.stop(id)
    return this.start(id)
  }

  /** 列出某 MCP Server 的工具（要求已启动） */
  async listTools(id: string): Promise<ToolSchema[]> {
    const entry = this.runtimes.get(id)
    if (!entry || !entry.client || entry.status !== 'running') {
      throw new Error('MCP Server 未运行，请先启动')
    }
    return entry.tools
  }

  /** 调用工具 */
  async callTool(id: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.runtimes.get(id)
    if (!entry || !entry.client || entry.status !== 'running') {
      throw new Error('MCP Server 未运行')
    }
    const result = await entry.client.request<any>(
      'tools/call',
      { name, arguments: args ?? {} },
      TOOL_CALL_TIMEOUT
    )
    return result
  }

  /** 停止所有运行中的 MCP Server（应用退出时调用） */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.runtimes.keys())
    await Promise.allSettled(ids.map((id) => this.stop(id)))
  }

  /** 把 MCP 协议返回的 tool 转成统一 ToolSchema */
  private normalizeMcpTool(raw: any, serverId: string): ToolSchema {
    const name: string = raw?.name ?? 'unknown'
    return {
      id: `mcp:${serverId}:${name}`,
      name,
      description: raw?.description ?? '',
      parameters: (raw?.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
      source: 'mcp',
      // MCP 工具权限按名称分级：
      //   - 命中危险关键词（写/删/执行类）→ confirm（必须人工确认）
      //   - 命中只读前缀（get/list/read/...）→ auto（放行，减少常用工具摩擦）
      //   - 其余未知语义 → confirm（保守默认，避免可疑工具直接执行）
      permission: classifyMcpToolPermission(name),
      mcpServerId: serverId
    }
  }

  private handleLog(serverId: string, stream: 'stdout' | 'stderr', line: string): void {
    const entry = this.runtimes.get(serverId)
    if (!entry) return
    entry.logBuffer.push(`[${stream}] ${line}`)
    if (entry.logBuffer.length > LOG_BUFFER_SIZE) {
      entry.logBuffer.shift()
    }
    const evt: McpServerLogEvent = {
      serverId,
      stream,
      line,
      timestamp: Date.now()
    }
    this.emit('log', evt)
  }

  private handleExit(id: string, code: number | null, signal: NodeJS.Signals | null, startToken: number): void {
    const entry = this.runtimes.get(id)
    if (!entry) return
    // 若是新的 start 流程触发的退出，忽略
    if (entry.startToken !== startToken) return
    if (entry.status === 'stopped') return // 主动停止导致的退出

    entry.client = null
    entry.tools = []
    // 崩溃时清除稳定运行定时器（未到稳定时长，计数器不复位）
    clearTimeout(entry.stableTimer)
    entry.stableTimer = undefined

    // 自动重启（最多 3 次）
    if (entry.autoRestarts < MAX_AUTO_RESTART) {
      entry.autoRestarts++
      entry.status = 'starting'
      entry.lastError = `进程意外退出 (code=${code}, signal=${signal?.toString() ?? 'null'})，第 ${entry.autoRestarts} 次自动重启`
      this.emitStatus(id, 'starting', entry.lastError)
      // 异步重启，不阻塞 exit 回调。若旧启动 Promise 仍在飞行（握手阶段崩溃），
      // 先等其落定并移出 in-flight 表，否则 start() 会去重到旧 Promise 而不重新 spawn
      const inflight = this.startingPromises.get(id)
      const reboot = () =>
        this.start(id).catch((e) => {
          // 失败由 start 内部已 emit error
          void e
        })
      if (inflight) void inflight.finally(reboot)
      else void reboot()
      return
    }

    entry.status = 'error'
    entry.lastError = `进程退出且已达自动重启上限 (code=${code}, signal=${signal?.toString() ?? 'null'})`
    this.emitStatus(id, 'error', entry.lastError)
  }

  private emitStatus(id: string, status: McpServerStatus, lastError?: string | null): void {
    const entry = this.runtimes.get(id)
    const evt: McpServerStatusEvent = {
      serverId: id,
      status,
      tools: entry?.tools ?? [],
      lastError: lastError ?? entry?.lastError ?? null,
      pid: entry?.client?.pid
    }
    this.emit('status', evt)
  }

  /** 订阅状态变化 */
  onStatus(handler: (e: McpServerStatusEvent) => void): () => void {
    this.on('status', handler)
    return () => this.off('status', handler)
  }

  /** 订阅日志 */
  onLog(handler: (e: McpServerLogEvent) => void): () => void {
    this.on('log', handler)
    return () => this.off('log', handler)
  }
}

export const mcpManager = new McpManager()
