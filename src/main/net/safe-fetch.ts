// safeFetch：主进程统一出网收口（SSRF 防护）
//
// 修复背景：web_fetch / 图片下载原先用全局 fetch + redirect:'follow'，重定向可跳往
// 127.0.0.1 / 169.254.169.254 等内网/元数据地址（初始 URL 校验被绕过），且无响应体
// 字节上限（可被巨型响应打爆内存）、不响应外部中止信号。
//
// 本模块基于 node:http(s) 手动实现：
//  - 仅允许 http/https；
//  - 每一跳（含重定向目标）都解析 DNS 并校验全部地址不落私网/环回/保留段；
//  - 连接钉在已校验的 IP 上（SNI/证书仍按原域名校验），防 DNS 重绑定 TOCTOU；
//  - 手动跟随重定向（默认最多 5 跳），跨跳不携带任何凭据（本模块从不存 Cookie）；
//  - 响应体流式读取并强制字节上限，Content-Length 超限直接拒收；
//  - 总超时贯穿「连接 + 响应头 + 读体」全程；
//  - 响应外部 AbortSignal，中止时立刻销毁底层连接。
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import fs from 'node:fs'

/** IPv6 展开后的 8 个 hextet 数字（expandIpv6 返回时保证长度为 8） */
type Hextets = [number, number, number, number, number, number, number, number]

export interface SafeFetchOptions {
  /** 外部中止信号（如 Agent 停止按钮）；中止时销毁底层连接 */
  signal?: AbortSignal
  /** 总超时毫秒数（连接+响应头+读体），默认 15000 */
  timeoutMs?: number
  /** 响应体字节上限，默认 5MB；超限销毁连接并抛错 */
  maxBytes?: number
  /** 最大重定向跳数，默认 5 */
  maxRedirects?: number
  /** HTTP 方法，默认 GET */
  method?: string
  /** 请求体（用于 POST/PUT）；会自动设置 Content-Length */
  body?: string | Buffer
  /** 附加请求头（如 Content-Type / Authorization） */
  headers?: Record<string, string>
  /**
   * 若提供，响应体直接流式写入该文件而非缓冲进内存（用于数百 MB 级下载）。
   * 仍受 maxBytes 硬上限保护；路径由调用方负责，本模块不做目录约束。
   */
  sinkFile?: string
  /** 下载进度回调（received 已收字节；total 取 Content-Length，缺失为 null） */
  onProgress?: (received: number, total: number | null) => void
}

export interface SafeFetchResult {
  status: number
  /** 键为小写；重复头以逗号合并 */
  headers: Record<string, string>
  body: Buffer
  /** 重定向后的最终 URL */
  finalUrl: string
}

export class SafeFetchError extends Error {}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REDIRECTS = 5
const USER_AGENT = 'PocketAI/0.1 (+local-first AI workstation)'

// ---------- IP 白/黑名单校验 ----------

/** IPv4 是否落在禁止访问的网段（环回/私网/链路本地/保留/组播等） */
export function isDisallowedIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number)
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const a = p[0]!
  const b = p[1]!
  if (a === 0) return true // 0.0.0.0/8 未指定
  if (a === 10) return true // 10.0.0.0/8
  if (a === 127) return true // 环回
  if (a === 169 && b === 254) return true // 链路本地（含 169.254.169.254 云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true // 192.0.0.0/24 与 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return true // 198.18/15 基准测试、198.51.100/24
  if (a === 203 && b === 0) return true // 203.0.113/24
  if (a >= 224) return true // 组播/保留/广播
  return false
}

/** 把 IPv6 展开成 8 个 hextet 数字；无法解析返回 null。兼容 '::' 压缩与尾部点分 IPv4 */
export function expandIpv6(ip: string): Hextets | null {
  if (!/^[0-9a-f:.]+$/i.test(ip)) return null
  let head = ip
  let tail = ''
  let hasCompress = false
  if (ip.includes('::')) {
    const parts = ip.split('::')
    if (parts.length > 2) return null
    head = parts[0] ?? ''
    tail = parts[1] ?? ''
    hasCompress = true
  }
  const parsePiece = (piece: string): number | 'v4' | null => {
    if (piece.includes('.')) return 'v4'
    return /^[0-9a-f]{1,4}$/i.test(piece) ? parseInt(piece, 16) : null
  }
  // 将一段段 pieces 解析为数字数组（点分 IPv4 占 2 个 hextet）；非法 piece → null
  const toNums = (pieces: string[]): number[] | null => {
    const out: number[] = []
    for (const piece of pieces) {
      const v = parsePiece(piece)
      if (v === null) return null
      if (v === 'v4') {
        const q = piece.split('.').map(Number)
        if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null
        out.push((q[0]! << 8) | q[1]!, (q[2]! << 8) | q[3]!)
      } else {
        out.push(v)
      }
    }
    return out
  }
  const headNums = toNums(head ? head.split(':') : [])
  if (headNums === null) return null
  const tailNums = toNums(tail ? tail.split(':') : [])
  if (tailNums === null) return null
  // 无 '::' 压缩：head+tail 必须正好 8 段
  if (!hasCompress) {
    const nums = [...headNums, ...tailNums]
    if (nums.length !== 8) return null
    return nums as Hextets
  }
  // 有 '::' 压缩：head 在前、tail 在后、中间补零到 8 段。
  // 关键：:: 在头部（::1）或中部（1::2）时，零必须填在 head 与 tail 之间，
  // 而非简单拼到末尾——否则 ::1 会错展开成 [1,0,...]，让 isDisallowedIpv6 漏判环回。
  if (headNums.length + tailNums.length >= 8) return null // :: 无补零空间则非法
  const nums: number[] = [...headNums]
  while (nums.length < 8 - tailNums.length) nums.push(0)
  nums.push(...tailNums)
  return nums as Hextets
}

function embeddedV4(h: Hextets, i: number): string {
  const v = ((h[i]! << 16) | h[i + 1]!) >>> 0
  return `${(v >>> 24) & 255}.${(v >>> 16) & 255}.${(v >>> 8) & 255}.${v & 255}`
}

/** IPv6 是否落在禁止访问的网段（含 IPv4-mapped / NAT64 内嵌地址的递归校验） */
export function isDisallowedIpv6(ip: string): boolean {
  const h = expandIpv6(ip)
  if (!h) return true // 解析不了的一律拒绝
  // IPv4-mapped ::ffff:0:0/96 与 NAT64 64:ff9b::/96：按内嵌 IPv4 判定
  if (h[0] === 0 && h[1] === 0 && h[2] === 0 && h[3] === 0 && h[4] === 0 && h[5] === 0xffff) {
    return isDisallowedIpv4(embeddedV4(h, 6))
  }
  if (h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0)) {
    return isDisallowedIpv4(embeddedV4(h, 6))
  }
  // 6to4 2002::/16：内嵌 IPv4 在第 2-3 个 hextet
  if (h[0] === 0x2002) return isDisallowedIpv4(embeddedV4(h, 1))
  // ::/128、::1/128 与已废弃的 IPv4 兼容段 ::a.b.c.d（hextet[5]===0 时 hextet[6..7] 即 IPv4）
  if (h[0] === 0 && h.slice(1, 5).every((x) => x === 0) && h[5] === 0) {
    if (h[6] === 0 && h[7] === 0) return true // ::
    if (h[6] === 0 && h[7] === 1) return true // ::1 环回
    return isDisallowedIpv4(embeddedV4(h, 6))
  }
  if (h[0] >= 0xfe80 && h[0] <= 0xfebf) return true // 链路本地
  if (h[0] >= 0xfc00 && h[0] <= 0xfdff) return true // ULA
  if (h[0] >= 0xff00) return true // 组播
  if (h[0] === 0x100 && h.slice(1, 4).every((x) => x === 0)) return true // 100::/64 丢弃段
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true // 文档段
  return false
}

export function isDisallowedIp(ip: string): boolean {
  const fam = net.isIP(ip)
  if (fam === 4) return isDisallowedIpv4(ip)
  if (fam === 6) return isDisallowedIpv6(ip)
  return true
}

// ---------- URL 与 DNS 校验 ----------

export function assertFetchable(u: URL): void {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new SafeFetchError(`仅支持 http/https 协议: ${u.protocol}`)
  }
  if (!u.hostname) throw new SafeFetchError('URL 缺少主机名')
}

/**
 * 解析并校验目标主机，返回一个允许连接的 IP（用于钉住连接防重绑定）。
 * 主机名是字面 IP 时直接校验；域名则取 DNS 全部记录逐个校验。
 */
async function resolveAndValidate(u: URL): Promise<string> {
  // WHATWG URL 对 IPv6 字面量主机名保留方括号（'[::1]'），先剥掉
  const raw = u.hostname.toLowerCase()
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new SafeFetchError(`禁止访问内网主机: ${host}`)
  }
  if (net.isIP(host)) {
    if (isDisallowedIp(host)) throw new SafeFetchError(`禁止访问内网/保留地址: ${host}`)
    return host
  }
  let list: { address: string }[]
  try {
    const resolved = await dns.promises.lookup(host, { all: true, verbatim: true })
    list = Array.isArray(resolved) ? resolved : [resolved]
  } catch {
    throw new SafeFetchError(`域名解析失败: ${host}`)
  }
  if (list.length === 0) throw new SafeFetchError(`域名解析失败: ${host}`)
  const ok = list.find((a) => !isDisallowedIp(a.address))
  if (!ok) throw new SafeFetchError(`目标解析到内网/保留地址，已拦截: ${host}`)
  return ok.address
}

// ---------- 底层请求 ----------

interface HopResult {
  req: http.ClientRequest
  res: http.IncomingMessage
}

/** 发起单跳请求；连接钉在已校验 IP 上，https 仍按原域名做 SNI 与证书校验。
 *  onRequest 在请求对象创建时同步回调，用于把外部 abort 接到「连接建立阶段」。 */
function requestOnce(
  u: URL,
  ip: string,
  method: string,
  body: string | Buffer | undefined,
  headers: Record<string, string>,
  deadline: number,
  onRequest: (req: http.ClientRequest) => void
): Promise<HopResult> {
  return new Promise<HopResult>((resolve, reject) => {
    const isHttps = u.protocol === 'https:'
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      reject(new SafeFetchError('SafeFetch 请求超时'))
      return
    }
    const bodyBuf: Buffer | undefined = body !== undefined ? Buffer.from(body) : undefined
    const reqHeaders: Record<string, string> = {
      Host: u.host,
      'User-Agent': USER_AGENT,
      ...headers
    }
    if (bodyBuf !== undefined) {
      reqHeaders['Content-Length'] = String(bodyBuf.length)
    }
    const options: https.RequestOptions = {
      method,
      host: ip,
      port: Number(u.port) || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      headers: reqHeaders,
      ...(isHttps ? { servername: u.hostname } : {})
    }
    const onRes = (res: http.IncomingMessage): void => {
      if (timer) clearTimeout(timer)
      res.on('error', reject) // 响应阶段错误（含主动销毁）走统一拒绝
      resolve({ req, res })
    }
    const req = isHttps ? https.request(options, onRes) : http.request(options, onRes)
    let timer: NodeJS.Timeout | undefined
    timer = setTimeout(() => {
      req.destroy(new SafeFetchError('SafeFetch 请求超时'))
    }, remaining)
    onRequest(req)
    req.on('error', (e) => {
      if (timer) clearTimeout(timer)
      reject(e)
    })
    if (bodyBuf !== undefined) req.write(bodyBuf)
    req.end()
  })
}

/** 流式读取响应体并强制字节上限；sink 模式直接落盘（返回空 Buffer） */
function readBody(
  res: http.IncomingMessage,
  req: http.ClientRequest,
  maxBytes: number,
  deadline: number,
  sink?: { file: string; onProgress?: (received: number, total: number | null) => void }
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const declared = Number(res.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      res.on('error', () => {})
      req.destroy()
      reject(new SafeFetchError(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`))
      return
    }
    const remaining = deadline - Date.now()
    const timer = setTimeout(() => {
      req.destroy(new SafeFetchError('SafeFetch 读取响应超时'))
    }, Math.max(remaining, 1))

    // sink 模式：边收边写文件，避免数百 MB 响应整体进内存
    if (sink) {
      const declaredTotal = Number.isFinite(declared) && declared > 0 ? declared : null
      const fileStream = fs.createWriteStream(sink.file)
      let received = 0
      let lastReport = 0
      const fail = (err: Error) => {
        clearTimeout(timer)
        fileStream.close(() => {
          fs.rm(sink.file, { force: true }, () => reject(err))
        })
      }
      fileStream.on('error', (err) => {
        req.destroy()
        fail(err)
      })
      res.on('data', (c: Buffer) => {
        received += c.length
        if (received > maxBytes) {
          req.destroy(new SafeFetchError(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`))
          return
        }
        fileStream.write(c)
        if (sink.onProgress && received - lastReport > 1_048_576) {
          lastReport = received
          sink.onProgress(received, declaredTotal)
        }
      })
      res.on('end', () => {
        sink.onProgress?.(received, declaredTotal)
        fileStream.end(() => {
          clearTimeout(timer)
          resolve(Buffer.alloc(0))
        })
      })
      res.on('error', (e) => {
        clearTimeout(timer)
        req.destroy()
        fail(e)
      })
      req.on('error', (e) => {
        clearTimeout(timer)
        fail(e)
      })
      return
    }

    const chunks: Buffer[] = []
    let total = 0
    res.on('data', (c: Buffer) => {
      total += c.length
      if (total > maxBytes) {
        // 销毁连接后错误经 res/req 的 error 监听进入 reject
        req.destroy(new SafeFetchError(`响应体超过上限（${Math.round(maxBytes / 1024 / 1024)}MB）`))
        chunks.length = 0
        return
      }
      chunks.push(c)
    })
    res.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks))
    })
    res.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** 归一化响应头：键小写、数组逗号合并 */
function normalizeHeaders(src: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(src)) {
    if (v === undefined) continue
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v
  }
  return out
}

/**
 * 安全抓取一个 URL（支持 GET/POST 等方法）。
 * 与全局 fetch 不同：手动跟随重定向并对每一跳重新做 SSRF 校验，连接钉在已校验 IP 上，
 * 响应体有硬性字节上限，全程受总超时与外部 AbortSignal 约束。
 *
 * 重定向安全策略：301/302/303 自动降级为 GET 并丢弃请求体（防止凭据/body 转发到第三方）；
 * 307/308 保留原方法与 body；每一跳的 headers 始终来自 opts.headers（含 Authorization），
 * 因此如需避免凭据泄漏到重定向目标，请设置 maxRedirects: 0。
 */
export async function safeFetch(rawUrl: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const signal = opts.signal

  let current: URL
  try {
    current = new URL(rawUrl)
  } catch {
    throw new SafeFetchError(`URL 无效: ${rawUrl}`)
  }
  assertFetchable(current)

  const deadline = Date.now() + timeoutMs
  let currentReq: http.ClientRequest | null = null
  const onAbort = () => {
    currentReq?.destroy(new SafeFetchError('已中止'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  // 重定向时可能降级方法/丢弃 body，用可变副本
  let method = (opts.method ?? 'GET').toUpperCase()
  let body: string | Buffer | undefined = opts.body

  try {
    for (let hop = 0; ; hop++) {
      if (signal?.aborted) throw new SafeFetchError('已中止')
      assertFetchable(current)
      const ip = await resolveAndValidate(current)
      if (signal?.aborted) throw new SafeFetchError('已中止')

      const { req, res } = await requestOnce(
        current,
        ip,
        method,
        body,
        opts.headers ?? {},
        deadline,
        (r) => {
          currentReq = r
        }
      )
      const status = res.statusCode ?? 0

      if (isRedirect(status)) {
        // 重定向：丢弃响应体并销毁连接，校验下一跳
        res.on('error', () => {})
        req.on('error', () => {})
        req.destroy()
        currentReq = null
        if (hop >= maxRedirects) throw new SafeFetchError('重定向次数超限')
        const loc = res.headers.location
        if (!loc) throw new SafeFetchError(`HTTP ${status} 重定向缺少 Location`)
        let next: URL
        try {
          next = new URL(loc, current)
        } catch {
          throw new SafeFetchError(`重定向地址无效: ${loc}`)
        }
        // 301/302/303：按 HTTP 语义降级为 GET 并丢弃 body（防止凭据/请求体转发到第三方）
        if (status === 301 || status === 302 || status === 303) {
          method = 'GET'
          body = undefined
        }
        // 307/308：保留 method 与 body
        current = next
        continue
      }

      const respBody = await readBody(
        res,
        req,
        maxBytes,
        deadline,
        opts.sinkFile ? { file: opts.sinkFile, onProgress: opts.onProgress } : undefined
      )
      return {
        status,
        headers: normalizeHeaders(res.headers),
        body: respBody,
        finalUrl: current.toString()
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
