// MCP Streamable HTTP transport 客户端
//
// 实现 MCP 协议的 Streamable HTTP transport（POST + SSE 响应流）：
//  - 每个 JSON-RPC 请求 POST 到 server URL，Accept: text/event-stream
//  - 响应可能是 SSE 流（event: result / event: notification）或直接 JSON
//  - initialize 响应的 Mcp-Session-Id header 作为会话 ID，后续请求带上
//  - 通知（notifications）从响应流中提取并转发
//
// 安全边界：
//  - URL 已由 shared/schemas/mcp.ts 校验为 http(s)
//  - MCP server 通常是用户配置的本地/远程服务，允许 localhost（不走 safeFetch 的内网拦截）
//  - 连接超时 + SSE 事件字节上限，防恶意 server 巨事件内存耗尽
//  - 直接 JSON 响应体同样有界读取
//  - 不做进程管理（无 spawn/exit），shutdown 仅发送协议级 shutdown 请求

import { EventEmitter } from 'node:events'
import { errMsg, isAbortError } from '../error'
import {
  McpBusinessError,
  McpTransportError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpTransportClient
} from './json-rpc'

export interface HttpTransportOptions {
  url: string
  /** 每个请求的超时（ms），默认 30000 */
  requestTimeout?: number
  /** SSE 单事件/响应体最大字节数，默认 32MB（与 stdio 对齐） */
  maxLineBytes?: number
}

/** 单条 SSE 事件的最大字节数（与 stdio NDJSON 上限对齐） */
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

/** 单次 POST 请求体最大字节数（防巨型请求撑爆内存/网络） */
const MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024

/**
 * 解析 SSE 流的异步生成器：从 ReadableStream 按 \n\n 切分事件，
 * 每个事件返回 { event, data }。
 *
 * 字节上限在「事件分隔符到达前」的累积阶段生效：pendingBytes 超过 maxBytes
 * 立即抛错终止请求（HTTP 单请求作用域，无需像 stdio 长连接那样丢弃单行保活），
 * 防止恶意 server 持续发送不含空行的数据导致 buffer 无界增长。
 */
export async function* parseSseStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder('utf-8')
  let buffer = ''
  /** 当前缓冲区（尚未切分的不完整事件）的 UTF-8 字节数 */
  let pendingBytes = 0
  const reader = stream.getReader()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      pendingBytes += value.byteLength
      if (pendingBytes > maxBytes) {
        // 不回显任何内容，防错误路径把巨串带入日志
        throw new McpTransportError('protocol', `SSE 事件超过 ${maxBytes} 字节上限，已终止响应读取`)
      }
      buffer += decoder.decode(value, { stream: true })

      // SSE 事件以空行（\n\n）分隔
      let sepIndex: number
      while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sepIndex)
        buffer = buffer.slice(sepIndex + 2)
        // 剩余缓冲区按实际字节数重新计数（精确，事件数量级合理时成本可忽略）
        pendingBytes = Buffer.byteLength(buffer, 'utf8')

        let event = 'message'
        const dataLines: string[] = []
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim()
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
          // 忽略 comment（: 开头）和其他字段
        }
        const data = dataLines.join('\n')
        if (Buffer.byteLength(data, 'utf8') > maxBytes) continue // 防御性丢弃
        yield { event, data }
      }
    }
    // 流结束时缓冲区剩余内容为不完整事件，忽略
  } finally {
    reader.releaseLock()
  }
}

/**
 * 有界读取整个响应体：累积字节超过 maxBytes 立即抛错，
 * 防止 `res.text()` 把恶意 server 的超大响应整体读进内存。
 */
export async function readBoundedBody(
  res: Response,
  maxBytes: number
): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new McpTransportError('protocol', `响应体超过 ${maxBytes} 字节上限，已终止读取`)
      }
      parts.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(parts).toString('utf8')
}

export class HttpJsonRpcClient implements McpTransportClient {
  private nextId = 1
  private closed = false
  private sessionId: string | null = null
  private emitter = new EventEmitter()
  /** 当前正在进行的请求的 AbortController（shutdown 时统一中止） */
  private inflight = new Set<AbortController>()

  constructor(private readonly opts: HttpTransportOptions) {}

  /** http 传输无本地进程，pid 恒为 undefined */
  get pid(): number | undefined {
    return undefined
  }

  get transportClosed(): boolean {
    return this.closed
  }

  /** http 传输无需预连接，spawn 仅做空操作（与 stdio 接口对齐） */
  async spawn(): Promise<void> {
    // no-op：http 连接在每次 request 时按需建立
  }

  /**
   * 发送 JSON-RPC 请求并等待响应。
   * 支持两种响应形态：
   *  1. Content-Type: application/json —— 直接解析为 JSON-RPC 响应
   *  2. Content-Type: text/event-stream —— 解析 SSE，等待 event: result
   */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('HTTP 传输通道已关闭'))
    }

    const id = this.nextId++
    const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params }
    const body = JSON.stringify(req)
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) {
      return Promise.reject(new Error(`请求体超过 ${MAX_REQUEST_BODY_BYTES} 字节上限`))
    }

    const timeout = timeoutMs ?? this.opts.requestTimeout ?? 30000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    this.inflight.add(controller)

    const cleanup = () => {
      clearTimeout(timer)
      this.inflight.delete(controller)
    }

    return (async (): Promise<T> => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream'
        }
        if (this.sessionId) {
          headers['Mcp-Session-Id'] = this.sessionId
        }

        const res = await fetch(this.opts.url, {
          method: 'POST',
          headers,
          body,
          signal: controller.signal,
          redirect: 'error' // 禁止重定向，防 SSRF 绕过
        })

        // 提取 session ID（initialize 响应通常带 Mcp-Session-Id）
        const sid = res.headers.get('Mcp-Session-Id')
        if (sid) this.sessionId = sid

        const contentType = res.headers.get('content-type') ?? ''
        const maxBytes = this.opts.maxLineBytes ?? DEFAULT_MAX_BYTES

        // 形态 1：直接 JSON 响应（有界读取）
        if (contentType.includes('application/json')) {
          const text = await readBoundedBody(res, maxBytes)
          const msg = JSON.parse(text) as JsonRpcResponse
          if (msg.error) throw new McpBusinessError(msg.error.code, msg.error.message)
          return msg.result as T
        }

        // 形态 2：SSE 流
        if (contentType.includes('text/event-stream') && res.body) {
          for await (const evt of parseSseStream(res.body, maxBytes)) {
            if (evt.event === 'result') {
              const msg = JSON.parse(evt.data) as JsonRpcResponse
              if (msg.error) throw new McpBusinessError(msg.error.code, msg.error.message)
              return msg.result as T
            }
            if (evt.event === 'notification') {
              try {
                const n = JSON.parse(evt.data) as JsonRpcNotification
                this.emitter.emit('notification', n)
              } catch {
                // 通知解析失败忽略，不影响请求响应
              }
            }
            // 其他 event（endpoint 等）v2 暂不处理
          }
          throw new McpTransportError('protocol', 'SSE 流结束未收到 result 事件')
        }

        // 未知 Content-Type：尝试当 JSON 解析（同样有界读取）
        const text = await readBoundedBody(res, maxBytes)
        try {
          const msg = JSON.parse(text) as JsonRpcResponse
          if (msg.error) throw new McpBusinessError(msg.error.code, msg.error.message)
          return msg.result as T
        } catch (e) {
          // JSON.parse 失败：统一报不支持的 Content-Type（响应体超限错误直接透传）
          if (e instanceof SyntaxError) {
            throw new McpTransportError('protocol', `不支持的响应 Content-Type: ${contentType}`)
          }
          throw e
        }
      } catch (e) {
        // 已分类的错误原样透传
        if (e instanceof McpTransportError || e instanceof McpBusinessError) throw e
        if (isAbortError(e)) {
          throw new McpTransportError('timeout', `JSON-RPC 请求超时: ${method} (${timeout}ms)`)
        }
        // fetch 网络失败 / JSON 响应体畸形：连接级失败
        throw new McpTransportError(e instanceof SyntaxError ? 'protocol' : 'network', errMsg(e))
      } finally {
        cleanup()
      }
    })()
  }

  /** 发送通知（POST，不等响应） */
  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const notif: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    const body = JSON.stringify(notif)
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BODY_BYTES) return

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.opts.requestTimeout ?? 30000)
    this.inflight.add(controller)

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream'
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId

    fetch(this.opts.url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'error'
    })
      .then(async (res) => {
        // 通知不需要响应体，但需要消费掉避免连接泄漏
        if (res.body) await res.body.cancel().catch(() => {})
      })
      .catch(() => {
        // 通知失败静默忽略
      })
      .finally(() => {
        clearTimeout(timer)
        this.inflight.delete(controller)
      })
  }

  onNotification(handler: (n: JsonRpcNotification) => void): () => void {
    this.emitter.on('notification', handler)
    return () => this.emitter.off('notification', handler)
  }

  /**
   * 优雅关闭：先发协议级 shutdown 请求（尽力而为），再中止所有进行中的请求。
   * 注意 shutdown 请求必须在置 closed 之前发出——request 入口对 closed 通道直接拒绝，
   * 若先标记 closed，协议消息永远发不出去（http 无本地进程可杀，只能走协议通知）。
   */
  async shutdown(timeoutMs = 3000): Promise<void> {
    if (this.closed) return

    // shutdown 请求自带 timeoutMs，完成/超时后其 controller 已从 inflight 移除
    try {
      await this.request('shutdown', undefined, timeoutMs)
    } catch {
      // 服务器未响应/不支持无关紧要：HTTP 无本地进程需要回收
    }

    this.closed = true
    for (const c of this.inflight) {
      try { c.abort() } catch {}
    }
    this.inflight.clear()
  }
}
