// 轻量 JSON-RPC 2.0 over stdio 客户端
// 不依赖外部 MCP SDK，自实现协议最小子集：initialize / tools/list / tools/call / shutdown
// 设计要点：
//  - 每行一个 JSON 请求/响应（NDJSON over stdio）
//  - 用自增 ID 关联请求与响应
//  - 支持 server -> client 的 notification（无 id）
//  - 超时控制：单次请求默认 30s
//  - 优雅退出：发送 shutdown 请求 → 等待进程退出 → 必要时强杀

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createInterface, type Interface } from 'node:readline'

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

export type StdioLogHandler = (stream: 'stdout' | 'stderr', line: string) => void

export interface StdioClientOptions {
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  /** 每个请求的超时（ms），默认 30000 */
  requestTimeout?: number
  /** 进程退出时回调 */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void
  /** stderr / 非协议 stdout 日志 */
  onLog?: StdioLogHandler
}

export class StdioJsonRpcClient {
  private proc: ChildProcessWithoutNullStreams | null = null
  private readline: Interface | null = null
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
    this.proc = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    })

    this.proc.on('exit', (code, signal) => {
      this.closed = true
      // 拒绝所有挂起请求
      for (const [id, entry] of this.pending.entries()) {
        clearTimeout(entry.timer)
        this.pending.delete(id)
        entry.reject(new Error(`MCP 进程退出 (code=${code}, signal=${signal?.toString() ?? 'null'})`))
      }
      this.opts.onExit?.(code, signal)
    })

    this.proc.on('error', (err) => {
      this.closed = true
      for (const [, entry] of this.pending) {
        entry.reject(new Error(`进程错误: ${err.message}`))
      }
    })

    // 解析 stdout 行
    this.readline = createInterface({ input: this.proc.stdout! })
    this.readline.on('line', (line) => this.handleLine(line))

    // stderr 作为日志
    const stderrRl = createInterface({ input: this.proc.stderr! })
    stderrRl.on('line', (line) => this.opts.onLog?.('stderr', line))

    // 等待 stdout 可写
    if (!this.proc.stdin.writable) {
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
        this.proc!.stdin.write(JSON.stringify(req) + '\n')
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`写入 stdin 失败: ${(e as Error).message}`))
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
    this.readline?.close()
    this.readline = null

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
        reject(e as Error)
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
