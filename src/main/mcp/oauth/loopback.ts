// OAuth 本机回环回调服务（RFC 8252）。
//
// 只监听 127.0.0.1 的随机端口，固定路径 /mcp/oauth/callback：
//  · 校验 state（不匹配的请求一律 400 并继续等待，避免被第三方打断/伪造）；
//  · 校验 Host 必须是本机回环（防 DNS rebinding 把回调打到别的 host）；
//  · 单次使用，10 分钟超时；回调页不含 token，也不执行脚本。
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { MCP_OAUTH_CALLBACK_PATH } from '../../../shared/mcp-oauth'

const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000

export interface LoopbackResult {
  code: string
  state: string
  /** RFC 9207：授权服务器回跳时带的 issuer，需与 AS metadata 的 issuer 一致（防 mix-up） */
  iss?: string
}

export class OAuthLoopbackServer {
  private server: Server | null = null
  private port = 0
  private settled = false
  private timer: NodeJS.Timeout | null = null
  private resolveFn: ((v: LoopbackResult) => void) | null = null
  private rejectFn: ((e: Error) => void) | null = null
  private readonly state: string
  private readonly timeoutMs: number

  constructor(state: string, timeoutMs = CALLBACK_TIMEOUT_MS) {
    this.state = state
    this.timeoutMs = timeoutMs
  }

  get redirectUri(): string {
    return `http://127.0.0.1:${this.port}${MCP_OAUTH_CALLBACK_PATH}`
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => this.handle(req, res))
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    if (!addr || typeof addr === 'string') throw new Error('OAuth 回调服务未取得端口')
    this.port = addr.port
  }

  /** 等待授权服务回调；超时/取消由 close() 结束 */
  waitForCode(): Promise<LoopbackResult> {
    return new Promise<LoopbackResult>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
      this.timer = setTimeout(() => {
        this.fail(new Error('授权超时（10 分钟），请重新发起授权。'))
      }, this.timeoutMs)
      this.timer.unref?.()
    })
  }

  close(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const server = this.server
    this.server = null
    if (server) {
      try {
        server.close()
        // Node 18+：把 keep-alive 连接一并断掉，避免端口迟迟不释放
        ;(server as Server & { closeAllConnections?: () => void }).closeAllConnections?.()
      } catch {
        /* 关闭失败不影响授权结果 */
      }
    }
  }

  cancel(reason = '授权已取消。'): void {
    this.fail(new Error(reason))
    this.close()
  }

  private fail(err: Error): void {
    if (this.settled) return
    this.settled = true
    const reject = this.rejectFn
    this.rejectFn = null
    this.resolveFn = null
    this.close()
    reject?.(err)
  }

  private succeed(result: LoopbackResult): void {
    if (this.settled) return
    this.settled = true
    const resolve = this.resolveFn
    this.resolveFn = null
    this.rejectFn = null
    this.close()
    resolve?.(result)
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const host = String(req.headers.host ?? '').toLowerCase()
    const expectedHost = `127.0.0.1:${this.port}`
    const hostOk = host === expectedHost || host === `localhost:${this.port}`
    if (!hostOk) {
      this.respond(res, 400, '回调地址校验失败')
      return
    }
    if (req.method !== 'GET') {
      this.respond(res, 405, '只接受 GET 回调')
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', `http://${expectedHost}`)
    } catch {
      this.respond(res, 400, '回调地址不合法')
      return
    }
    if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
      this.respond(res, 404, '未找到回调路径')
      return
    }
    const state = url.searchParams.get('state') ?? ''
    // state 不匹配：不结束流程，避免第三方用错误 state 打断合法授权
    if (!state || state !== this.state) {
      this.respond(res, 400, '授权状态校验失败，请回到应用重新发起授权')
      return
    }
    const err = url.searchParams.get('error')
    if (err) {
      this.respond(res, 400, '授权未完成，请回到应用查看原因')
      this.fail(new Error(`授权服务返回错误：${err}`))
      return
    }
    const code = url.searchParams.get('code')
    if (!code) {
      this.respond(res, 400, '回调缺少授权码')
      this.fail(new Error('授权回调缺少授权码，请重新授权。'))
      return
    }
    const iss = url.searchParams.get('iss') ?? undefined
    this.respond(res, 200, '授权完成，可以关闭此页面并回到 PocketAI')
    this.succeed({ code, state, ...(iss ? { iss } : {}) })
  }

  private respond(res: ServerResponse, status: number, text: string): void {
    res.statusCode = status
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>PocketAI 授权</title></head>` +
        `<body style="font-family:system-ui;padding:32px"><p>${text}</p></body></html>`
    )
  }
}
