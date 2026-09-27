// 轻量 JSON-RPC 2.0 over stdio 客户端
// 不依赖外部 MCP SDK，自实现协议最小子集：initialize / tools/list / tools/call / shutdown
// 设计要点：
//  - 每行一个 JSON 请求/响应（NDJSON over stdio）
//  - 用自增 ID 关联请求与响应
//  - 支持 server -> client 的 notification（无 id）
//  - 超时控制：单次请求默认 30s
//  - 优雅退出：发送 shutdown 请求 → 等待进程退出 → 必要时强杀
//  - 单行字节上限：恶意/被投毒 server 输出无换行巨行时丢弃，防内存耗尽 DoS

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Readable } from 'node:stream'
import { errMsg } from '../error'

/** 单条 NDJSON 消息/日志行的最大字节数（正常协议消息远小于此） */
export const DEFAULT_MAX_LINE_BYTES = 32 * 1024 * 1024

interface BoundedLineReader {
  stop(): void
}

/**
 * 带上限的行读取器（readline 没有行长度限制，一条数 GB 的无换行行会吃光主进程内存）。
 * 自行按 \n 切分；单行超过 maxBytes 后停止缓存该行内容直到下一个换行，丢弃并回调一次
 * onOverflow（回调不得携带行内容，避免警告路径本身把巨串带入日志缓冲）。
 */
function createBoundedLineReader(
  stream: Readable,
  onLine: (line: string) => void,
  onOverflow: (limitBytes: number) => void,
  maxBytes: number
): BoundedLineReader {
  const parts: Buffer[] = []
  let pending = 0
  let discarding = false

  const onData = (chunk: Buffer): void => {
    let start = 0
    while (start < chunk.length) {
      const nl = chunk.indexOf(0x0a, start)
      const end = nl === -1 ? chunk.length : nl
      const piece = chunk.subarray(start, end)
      if (!discarding) {
        if (pending + piece.length > maxBytes) {
          discarding = true
          parts.length = 0
          pending = 0
          onOverflow(maxBytes)
        } else if (piece.length > 0) {
          // copy 一份：chunk 可能被流回收，subarray 只是共享内存的视图
          parts.push(Buffer.from(piece))
          pending += piece.length
        }
      }
      if (nl === -1) break
      if (!discarding) {
        const line = Buffer.concat(parts).toString('utf8').replace(/\r$/, '')
        parts.length = 0
        pending = 0
        if (line.trim()) onLine(line)
      } else {
        // 被丢弃行的行尾到达，下个字节起恢复解析
        discarding = false
      }
      start = nl + 1
    }
  }

  stream.on('data', onData)
  return { stop: () => stream.off('data', onData) }
}

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

export interface StdioLogHandler {
  (stream: 'stdout' | 'stderr', line: string): void
}

/** 传输级错误类别：连接级失败，非 server 正常响应 */
export type McpTransportErrorKind = 'network' | 'timeout' | 'protocol'

/**
 * 传输级错误：请求未能获得 server 的有效协议响应
 * （网络不可达、请求超时、SSE 异常、响应超限等）。
 * manager 据此判断远端服务已不可用；与 {@link McpBusinessError} 相区别。
 */
export class McpTransportError extends Error {
  readonly kind: McpTransportErrorKind
  constructor(kind: McpTransportErrorKind, message: string) {
    super(message)
    this.name = 'McpTransportError'
    this.kind = kind
  }
}

/**
 * 业务级错误：server 存活并正常返回了 JSON-RPC error 响应。
 * 连接状态不应因此改变（工具本身执行失败 ≠ 服务不可用）。
 */
export class McpBusinessError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(`${message} (code=${code})`)
    this.name = 'McpBusinessError'
    this.code = code
  }
}

/**
 * MCP 传输层客户端公共接口。
 * stdio（StdioJsonRpcClient）与 http（HttpJsonRpcClient）共享同一契约，
 * manager 不关心底层传输方式，只面向此接口编程。
 */
export interface McpTransportClient {
  /** 进程 PID（http 传输无本地进程，返回 undefined） */
  readonly pid: number | undefined
  /** 传输通道是否已关闭 */
  readonly transportClosed: boolean
  /** 建立连接/启动进程 */
  spawn(): Promise<void>
  /** 发送 JSON-RPC 请求并等待响应 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>
  /** 发送 JSON-RPC 通知（无 id，不等响应） */
  notify(method: string, params?: unknown): void
  /** 注册 server 推送的通知处理器，返回取消函数 */
  onNotification(handler: (n: JsonRpcNotification) => void): () => void
  /** 优雅关闭 */
  shutdown(timeoutMs?: number): Promise<void>
}

export interface StdioClientOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** 每个请求的超时（ms），默认 30000 */
  requestTimeout?: number
  /** 单行 NDJSON/日志的最大字节数，默认 DEFAULT_MAX_LINE_BYTES */
  maxLineBytes?: number
  /** 进程退出时回调 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  /** stderr / 非协议 stdout 日志 */
  onLog?: StdioLogHandler
}

export class StdioJsonRpcClient implements McpTransportClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private stdoutReader: BoundedLineReader | null = null
  private stderrReader: BoundedLineReader | null = null
  private nextId = 1
  private pending = new Map<
    number | string,
    { resolve: (r: JsonRpcResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >()
  private emitter = new EventEmitter()
  private closed = false

  constructor(private readonly opts: StdioClientOptions) {}

  get pid(): number | undefined {
    return this.proc?.pid
  }

  get transportClosed(): boolean {
    return this.closed
  }

  /** 启动子进程，开始监听 stdout */
  async spawn(): Promise<void> {
    if (this.proc) return
    const { command, args = [], env, cwd } = this.opts
    // 用局部变量 proc 保持类型收窄，事件回调闭包内不需要 this.proc! 断言；
    // ChildProcessWithoutNullStreams 的 stdin/stdout/stderr 类型本身就是非 null 的 Writable
    const proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.proc = proc

    proc.on('exit', (code, signal) => {
      this.closed = true
      // 拒绝所有挂起请求
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(new Error(`MCP 进程退出 (code=${code}, signal=${signal?.toString() ?? 'null'})`))
      }
      this.opts.onExit?.(code, signal)
    })

    proc.on('error', (err) => {
      this.closed = true
      // 与 exit 一致：清 timer + 删 pending + reject，避免 timer 残留二次 reject
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(new Error(`进程错误: ${err.message}`))
      }
    })

    // 解析 stdout NDJSON（带单行字节上限，防恶意 server 巨行内存耗尽）
    const maxLineBytes = this.opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
    this.stdoutReader = createBoundedLineReader(
      proc.stdout,
      (line) => this.handleLine(line),
      () => this.opts.onLog?.('stdout', '[协议消息超过单行大小上限，已丢弃]'),
      maxLineBytes
    )

    // stderr 作为日志（同样限单行大小，且不把巨串灌进日志环形缓冲）
    this.stderrReader = createBoundedLineReader(
      proc.stderr,
      (line) => this.opts.onLog?.('stderr', line),
      () => this.opts.onLog?.('stderr', '[日志行超过单行大小上限，已丢弃]'),
      maxLineBytes
    )

    // 等待 stdout 可写
    if (!proc.stdin.writable) {
      throw new Error('子进程 stdin 不可写')
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: JsonRpcResponse | JsonRpcNotification
    try {
      msg = JSON.parse(trimmed)
    } catch {
      this.opts.onLog?.('stdout', trimmed)
      return
    }
    // 响应：有 id 且有 result/error
    if ('id' in msg && ('result' in msg || 'error' in msg)) {
      const entry = this.pending.get(msg.id)
      if (entry) {
        clearTimeout(entry.timer)
        this.pending.delete(msg.id)
        entry.resolve(msg as JsonRpcResponse)
      }
      return
    }
    // 通知：无 id
    if (!('id' in msg) || (msg as JsonRpcRequest).id === undefined) {
      this.emitter.emit('notification', msg)
      return
    }
    // 其他（带 id 的请求从 server 发来，v1 暂不处理）
    this.opts.onLog?.('stdout', trimmed)
  }

  /** 发送请求并等待响应 */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.proc || this.closed) {
      return Promise.reject(new Error('JSON-RPC 通道已关闭'))
    }
    // 局部变量 proc 保持类型收窄：Promise executor 闭包内 this 类成员会丢失收窄
    const proc = this.proc
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const timeout = timeoutMs ?? this.opts.requestTimeout ?? 30000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`JSON-RPC 请求超时: ${method} (${timeout}ms)`))
      }, timeout)

      this.pending.set(id, {
        resolve: (resp) => {
          if (resp.error) {
            reject(new Error(`${resp.error.message} (code=${resp.error.code})`))
          } else {
            resolve(resp.result as T)
          }
        },
        reject,
        timer
      })

      try {
        proc.stdin.write(JSON.stringify(req) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写入 stdin 失败: ${errMsg(e)}`))
      }
    })
  }

  /** 发送通知（无 id，不等响应） */
  notify(method: string, params?: unknown): void {
    if (!this.proc || this.closed || !this.proc.stdin.writable) return
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    try {
      this.proc.stdin.write(JSON.stringify(notif) + '\n')
    } catch {
      // 忽略写入失败
    }
  }

  onNotification(handler: (n: JsonRpcNotification) => void): () => void {
    this.emitter.on('notification', handler)
    return () => this.emitter.off('notification', handler)
  }

  /** 优雅关闭：尝试发送 shutdown + exit，超时后 SIGKILL */
  async shutdown(timeoutMs = 3000): Promise<void> {
    if (!this.proc) return
    const proc = this.proc
    this.proc = null
    this.stdoutReader?.stop()
    this.stderrReader?.stop()
    this.stdoutReader = null
    this.stderrReader = null

    if (!this.closed && proc.stdin.writable) {
      try {
        await this.requestRaw('shutdown', undefined, timeoutMs, proc)
        this.notifyRaw('exit', undefined, proc)
      } catch {
        // 超时/失败走强杀
      }
    }

    if (!this.closed) {
      try {
        proc.kill('SIGTERM')
      } catch {}
      // 再给 500ms 退出，否则 SIGKILL
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {}
          resolve()
        }, 500)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    }
  }

  private requestRaw(method: string, params: unknown, timeoutMs: number, proc: ChildProcessWithoutNullStreams): Promise<unknown> {
    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (resp) => resp.error ? reject(new Error(resp.error.message)) : resolve(resp.result),
        reject,
        timer
      })
      try {
        proc.stdin.write(JSON.stringify(req) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        // 统一拒绝值为 Error 实例：消费方按 .message/.name 处理，非 Error 抛出包一层
        reject(e instanceof Error ? e : new Error(errMsg(e)))
      }
    })
  }

  private notifyRaw(method: string, params: unknown, proc: ChildProcessWithoutNullStreams): void {
    if (!proc.stdin.writable) return
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    try {
      proc.stdin.write(JSON.stringify(notif) + '\n')
    } catch {}
  }
}
