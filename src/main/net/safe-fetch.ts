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
//  - 总超时贯穿「DNS + 连接 + 响应头 + 读体」全程，DNS 另有独立超时；
//  - 可选走用户配置的 HTTP 代理（默认直连）：仍先做 SSRF/私网校验，
//    CONNECT 目标写已校验 IP（保持防 DNS 重绑定），本机与 allowPrivateOrigin 目标强制直连；
//  - 响应外部 AbortSignal，中止时立刻销毁底层连接。
import http from 'node:http'
import https from 'node:https'
import dns from 'node:dns'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import type { Duplex } from 'node:stream'

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
  /**
   * 精确 origin 私网放行（默认关闭）：仅当请求 URL 的 origin（协议+主机+端口）
   * 与这里完全一致时，才允许连接本机/内网地址；重定向到其它 origin 不继承放行。
   * 仅供用户显式确认的 SearXNG 实例使用，web_fetch 等通用抓取不得传入。
   */
  allowPrivateOrigin?: string
  /**
   * 是否允许走用户在设置里配置的 HTTP 代理（默认 false=直连）。
   * 只有固定域名/用户显式动作的调用点才应打开；模型/用户给出的运行时 URL 保持直连。
   * 打开后仍先做 SSRF/私网校验，CONNECT 的是已校验 IP；本机目标与 allowPrivateOrigin 强制直连。
   */
  useProxy?: boolean
  /** DNS 解析超时毫秒数，默认 5000；超时抛「SafeFetch 域名解析超时」 */
  dnsTimeoutMs?: number
  /**
   * 是否允许跨 origin 重定向时继续携带凭据头（默认 false，自动剥离）。
   * 打开后会在控制台留一条审计告警；只在确实需要跨站 Bearer 转发时使用。
   */
  allowCredentialForwarding?: boolean
}

/** 超时/失败发生的阶段（错误文案与排查用） */
export type SafeFetchPhase = 'dns' | 'connect' | 'tunnel' | 'tls' | 'ttfb' | 'body'

export interface SafeFetchResult {
  status: number
  /** 键为小写；重复头以逗号合并 */
  headers: Record<string, string>
  body: Buffer
  /** 重定向后的最终 URL */
  finalUrl: string
}

export class SafeFetchError extends Error {
  /** 失败发生的阶段；非超时类错误可能为空 */
  readonly phase?: SafeFetchPhase
  constructor(message: string, phase?: SafeFetchPhase) {
    super(message)
    this.name = 'SafeFetchError'
    this.phase = phase
  }
}

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_DNS_TIMEOUT_MS = 5_000
const DEFAULT_MAX_REDIRECTS = 5
const USER_AGENT = 'PocketAI/0.1 (+local-first AI workstation)'

/** 跨 origin 重定向时必须剥离的请求头（M3） */
const CREDENTIAL_REQUEST_HEADERS = [
  'authorization',
  'cookie',
  'proxy-authorization',
  'www-authenticate'
] as const

/**
 * 就地剥离凭据头，返回被剥离的键名（大小写保留，供审计日志）。
 * 供跨 origin 重定向使用；同 origin 与普通请求不受影响。
 */
export function stripCredentialHeaders(headers: Record<string, string>): string[] {
  const stripped: string[] = []
  for (const key of Object.keys(headers)) {
    if ((CREDENTIAL_REQUEST_HEADERS as readonly string[]).includes(key.toLowerCase())) {
      delete headers[key]
      stripped.push(key)
    }
  }
  return stripped
}

/** 阶段 → 超时文案（统一大写 SafeFetch 前缀，便于用户/日志检索） */
function phaseTimeoutMessage(phase: SafeFetchPhase): string {
  switch (phase) {
    case 'dns':
      return 'SafeFetch 域名解析超时'
    case 'connect':
      return 'SafeFetch 请求超时（连接）'
    case 'tunnel':
      return 'SafeFetch 请求超时（代理隧道）'
    case 'tls':
      return 'SafeFetch 请求超时（TLS 握手）'
    case 'ttfb':
      return 'SafeFetch 请求超时（等待响应）'
    case 'body':
      return 'SafeFetch 读取响应超时（读体）'
  }
}

/** 连接类底层错误码 → 中文说明（原始 message 保留在括号里，便于排查） */
const CONNECTION_ERROR_TEXT: Record<string, string> = {
  ECONNRESET: '连接被重置',
  ECONNREFUSED: '连接被拒绝',
  EHOSTUNREACH: '主机不可达',
  ENETUNREACH: '网络不可达',
  ENETDOWN: '网络不可用',
  ETIMEDOUT: '连接超时',
  EPIPE: '连接已中断',
  ECONNABORTED: '连接被中止'
}

/**
 * 把底层连接类错误包装成可行动文案，风格与超时文案一致：
 * `SafeFetch 连接被重置（read ECONNRESET）`。
 * 其余错误（自建 SafeFetchError、HTTP 状态码、JSON 解析、SSRF 拦截等）原样返回，语义不变。
 */
function wrapConnectionError(e: unknown, phase?: SafeFetchPhase): unknown {
  if (e instanceof SafeFetchError) return e
  if (!(e instanceof Error)) return e
  const code = (e as NodeJS.ErrnoException).code
  const label = code ? CONNECTION_ERROR_TEXT[code] : undefined
  if (!label) return e
  return new SafeFetchError(`SafeFetch ${label}（${e.message}）`, phase)
}

// ---------- 代理 resolver（由 net/proxy.ts 注册，本模块不依赖 DB/Electron） ----------

/** 返回已规整的 http(s) 代理 URL；null/空串=直连。由 proxy.ts 在启动与保存后注册。 */
let proxyResolver: (() => string | null) | null = null

/** 注册 / 清除代理来源（传 null 即恢复全部直连）。仅 net/proxy.ts 调用。 */
export function registerProxyResolver(fn: (() => string | null) | null): void {
  proxyResolver = fn
}

interface ProxyConfig {
  host: string
  port: number
  /** 是否 TLS 连代理本身（https:// 代理） */
  tls: boolean
  /** CONNECT 用的 Proxy-Authorization 值；绝不写入日志/错误文案 */
  authHeader: string | null
  /** 可安全展示的 host:port（不含凭据） */
  display: string
}

/** 解析代理 URL；非法返回 null（坏配置降级直连，不阻断出网） */
function parseProxyConfig(raw: string | null | undefined): ProxyConfig | null {
  const s = (raw ?? '').trim()
  if (s === '') return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  if (!u.hostname) return null
  const isTls = u.protocol === 'https:'
  const port = Number(u.port) || (isTls ? 443 : 80)
  let authHeader: string | null = null
  if (u.username !== '' || u.password !== '') {
    const cred = `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
    authHeader = 'Basic ' + Buffer.from(cred, 'utf8').toString('base64')
  }
  return { host: u.hostname, port, tls: isTls, authHeader, display: `${u.hostname}:${port}` }
}

// ---------- 出口计数（P0-5 dry-run 判据） ----------
//
// 只数**真正发出去的请求**：每次建连（含重定向的每一跳）加一。
// 参数校验失败、超时在发请求前被拒的，不计数——那不是"出口调用"。
// 这是只读计数，不改变任何出网行为；`dry-run` 回放前后各取一次做全等断言。
let outboundRequestCount = 0

/** 进程启动以来的出网请求数（safeFetch 口径；直接 fetch 调用点不在内，见 dry-run-safety 的说明） */
export function getOutboundRequestCount(): number {
  return outboundRequestCount
}

/** 仅供测试/诊断复位计数；生产路径不要调用 */
export function resetOutboundRequestCount(): void {
  outboundRequestCount = 0
}

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

/** 主机名是否属于本机/内网/保留语义（字面 IP 或常见内网后缀；域名解析结果另由 resolveAndValidate 判定） */
export function isPrivateHostname(hostname: string): boolean {
  const raw = hostname.toLowerCase()
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true
  }
  if (net.isIP(host)) return isDisallowedIp(host)
  return false
}

/**
 * 解析并校验目标主机，返回一个允许连接的 IP（用于钉住连接防重绑定）。
 * 主机名是字面 IP 时直接校验；域名则取 DNS 全部记录逐个校验。
 * allowPrivate=true 仅由 allowPrivateOrigin 精确匹配的调用方传入（默认仍拒绝私网）。
 */
async function resolveAndValidate(
  u: URL,
  allowPrivate = false,
  dnsTimeoutMs = DEFAULT_DNS_TIMEOUT_MS,
  deadline = Number.POSITIVE_INFINITY
): Promise<string> {
  // WHATWG URL 对 IPv6 字面量主机名保留方括号（'[::1]'），先剥掉
  const raw = u.hostname.toLowerCase()
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (isPrivateHostname(host)) {
    if (!allowPrivate) throw new SafeFetchError(`禁止访问内网主机: ${host}`)
  }
  if (net.isIP(host)) {
    if (!allowPrivate && isDisallowedIp(host)) throw new SafeFetchError(`禁止访问内网/保留地址: ${host}`)
    return host
  }
  let list: { address: string }[]
  // DNS 本身必须有界：否则解析挂起时会绕过总超时，最后统一报成「请求超时」而看不出真实阶段
  const budget = Math.max(1, Math.min(dnsTimeoutMs, deadline - Date.now()))
  try {
    const resolved = await lookupWithTimeout(host, budget)
    list = Array.isArray(resolved) ? resolved : [resolved]
  } catch (e) {
    if (e instanceof SafeFetchError) throw e
    throw new SafeFetchError(`域名解析失败: ${host}`)
  }
  if (list.length === 0) throw new SafeFetchError(`域名解析失败: ${host}`)
  const ok = list.find((a) => !isDisallowedIp(a.address))
  if (!ok) {
    if (allowPrivate) return list[0]!.address
    throw new SafeFetchError(`目标解析到内网/保留地址，已拦截: ${host}`)
  }
  return ok.address
}

/** dns.lookup + 独立超时；超时文案带阶段，便于和「连接/等待响应」区分 */
function lookupWithTimeout(host: string, ms: number): Promise<dns.LookupAddress[]> {
  const pending = dns.promises.lookup(host, { all: true, verbatim: true })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const label = ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms)}ms`
      reject(new SafeFetchError(`${phaseTimeoutMessage('dns')}（${label}）`, 'dns'))
    }, ms)
  })
  return Promise.race([pending, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
    // 超时后底层查询仍可能失败，避免未处理的 rejection
    pending.catch(() => {})
  })
}

// ---------- 底层请求 ----------

interface HopResult {
  req: http.ClientRequest
  res: http.IncomingMessage
}

// ---------- 代理隧道 ----------
//
// 安全边界：目标域名先由 resolveAndValidate 解析并校验，CONNECT 的目标写「已校验 IP」，
// 代理只做 TCP 转发，不能把连接改投到其它地址；https 的 SNI/证书仍按原域名校验。
// 代理地址本身不参与私网拦截（本机 127.0.0.1:7890 是常见合法配置）。

const MAX_PROXY_HEAD_BYTES = 8 * 1024

/** 等待 net socket 建连；超时/关闭都按指定阶段失败 */
function waitForConnect(socket: net.Socket, ms: number, phase: SafeFetchPhase): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (err?: Error): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (err) reject(err)
      else resolve()
    }
    const onConnect = (): void => finish()
    const onError = (e: Error): void => finish(e)
    const onClose = (): void => finish(new SafeFetchError(phaseTimeoutMessage(phase), phase))
    socket.once('connect', onConnect)
    socket.once('error', onError)
    socket.once('close', onClose)
    if (!socket.connecting) finish()
    else timer = setTimeout(() => finish(new SafeFetchError(phaseTimeoutMessage(phase), phase)), Math.max(ms, 1))
  })
}

/** 等待 TLS 握手完成（含代理自身的 TLS 与目标 TLS） */
function waitForTls(socket: tls.TLSSocket, ms: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false
    let timer: NodeJS.Timeout | undefined
    const finish = (err?: Error): void => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      socket.removeListener('secureConnect', onSecure)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
      if (err) reject(err)
      else resolve()
    }
    const onSecure = (): void => finish()
    const onError = (e: Error): void => finish(e)
    const onClose = (): void => finish(new SafeFetchError(phaseTimeoutMessage('tls'), 'tls'))
    socket.once('secureConnect', onSecure)
    socket.once('error', onError)
    socket.once('close', onClose)
    timer = setTimeout(() => finish(new SafeFetchError(phaseTimeoutMessage('tls'), 'tls')), Math.max(ms, 1))
  })
}

/** 读取 CONNECT 应答头（到空行为止），返回状态码与剩余字节 */
function readConnectResponse(
  socket: net.Socket | tls.TLSSocket,
  ms: number
): Promise<{ status: number; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0)
    let done = false
    let timer: NodeJS.Timeout | undefined
    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    const fail = (err: Error): void => {
      if (done) return
      done = true
      cleanup()
      reject(err)
    }
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk])
      const idx = buf.indexOf('\r\n\r\n')
      if (idx < 0) {
        if (buf.length > MAX_PROXY_HEAD_BYTES) {
          fail(new SafeFetchError('SafeFetch 代理隧道响应异常（应答头超长）', 'tunnel'))
        }
        return
      }
      const head = buf.subarray(0, idx).toString('latin1')
      const m = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(head)
      if (!m) {
        fail(new SafeFetchError('SafeFetch 代理隧道响应异常（无法解析状态行）', 'tunnel'))
        return
      }
      done = true
      cleanup()
      resolve({ status: Number(m[1]), rest: buf.subarray(idx + 4) })
    }
    const onError = (e: Error): void => fail(e)
    const onClose = (): void => fail(new SafeFetchError(phaseTimeoutMessage('tunnel'), 'tunnel'))
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
    timer = setTimeout(() => fail(new SafeFetchError(phaseTimeoutMessage('tunnel'), 'tunnel')), Math.max(ms, 1))
  })
}

/**
 * 通过代理建立到「已校验 IP」的隧道；https 目标在隧道内再做一次 TLS（SNI=原域名）。
 * 返回可直接承载 HTTP 报文的流。代理凭据只出现在 CONNECT 头里，不进入错误文案。
 */
async function openProxyTunnel(
  proxy: ProxyConfig,
  u: URL,
  ip: string,
  deadline: number,
  signal?: AbortSignal
): Promise<Duplex> {
  const remaining = (): number => deadline - Date.now()
  let socket: net.Socket | tls.TLSSocket | null = null
  let aborted = false
  /** 当前子阶段，供连接类错误标注（连接代理 → 代理 TLS → CONNECT 隧道 → 目标 TLS） */
  let phase: SafeFetchPhase = 'connect'
  const onAbort = (): void => {
    aborted = true
    socket?.destroy()
  }
  if (signal?.aborted) throw new SafeFetchError('已中止')
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (remaining() <= 0) throw new SafeFetchError(phaseTimeoutMessage('connect'), 'connect')
    const raw = net.connect({ host: proxy.host, port: proxy.port })
    socket = raw
    await waitForConnect(raw, remaining(), 'connect')

    let carrier: net.Socket | tls.TLSSocket = raw
    if (proxy.tls) {
      phase = 'tls'
      const outer = tls.connect({ socket: raw, servername: proxy.host })
      socket = outer
      await waitForTls(outer, remaining())
      carrier = outer
    }

    phase = 'tunnel'
    const targetPort = Number(u.port) || (u.protocol === 'https:' ? 443 : 80)
    const authority = `${ip}:${targetPort}`
    const head =
      `CONNECT ${authority} HTTP/1.1\r\n` +
      `Host: ${authority}\r\n` +
      (proxy.authHeader ? `Proxy-Authorization: ${proxy.authHeader}\r\n` : '') +
      'Proxy-Connection: Keep-Alive\r\n\r\n'
    carrier.write(head)

    const { status, rest } = await readConnectResponse(carrier, remaining())
    if (status !== 200) {
      const message =
        status === 407
          ? `SafeFetch 代理认证失败（HTTP 407，代理 ${proxy.display}）`
          : `SafeFetch 代理拒绝连接（HTTP ${status}，代理 ${proxy.display}）`
      throw new SafeFetchError(message, 'tunnel')
    }
    if (rest.length > 0) {
      try {
        carrier.unshift(rest)
      } catch {
        // CONNECT 成功后代理不应再发数据；无法回填时忽略，后续握手会自然失败
      }
    }
    if (u.protocol !== 'https:') return carrier
    if (remaining() <= 0) throw new SafeFetchError(phaseTimeoutMessage('tls'), 'tls')
    phase = 'tls'
    const target = tls.connect({ socket: carrier, servername: u.hostname })
    socket = target
    await waitForTls(target, remaining())
    return target
  } catch (e) {
    socket?.destroy()
    if (aborted) throw new SafeFetchError('已中止')
    throw wrapConnectionError(e, phase)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

/** 把已建立（含 TLS）的流交给 http 客户端，避免 Agent 再次做 DNS/TLS */
class TunnelAgent extends http.Agent {
  private readonly factory: () => Duplex
  constructor(factory: () => Duplex) {
    super({ keepAlive: false })
    this.factory = factory
  }
  override createConnection(
    _options: net.NetConnectOpts,
    callback?: (err: Error | null, stream: Duplex) => void
  ): Duplex | null | undefined {
    const socket = this.factory()
    callback?.(null, socket)
    return socket
  }
}

/** 发起单跳请求；连接钉在已校验 IP 上，https 仍按原域名做 SNI 与证书校验。
 *  传入 proxy 时先建隧道（CONNECT 已校验 IP），HTTP 报文在隧道内发送。
 *  onRequest 在请求对象创建时同步回调，用于把外部 abort 接到「连接建立阶段」。 */
async function requestOnce(
  u: URL,
  ip: string,
  method: string,
  body: string | Buffer | undefined,
  headers: Record<string, string>,
  deadline: number,
  onRequest: (req: http.ClientRequest) => void,
  proxy: ProxyConfig | null,
  signal?: AbortSignal
): Promise<HopResult> {
  const isHttps = u.protocol === 'https:'
  const port = Number(u.port) || (isHttps ? 443 : 80)
  const bodyBuf: Buffer | undefined = body !== undefined ? Buffer.from(body) : undefined
  const reqHeaders: Record<string, string> = {
    Host: u.host,
    'User-Agent': USER_AGENT,
    ...headers
  }
  if (bodyBuf !== undefined) {
    reqHeaders['Content-Length'] = String(bodyBuf.length)
  }

  let tunnel: Duplex | null = null
  if (proxy) tunnel = await openProxyTunnel(proxy, u, ip, deadline, signal)

  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    if (tunnel) tunnel.destroy()
    throw new SafeFetchError(phaseTimeoutMessage(proxy ? 'ttfb' : 'connect'), proxy ? 'ttfb' : 'connect')
  }

  return new Promise<HopResult>((resolve, reject) => {
    // 直连时用 socket 事件细化「连接 / TLS / 等待响应」；代理隧道已在上面建好
    let phase: SafeFetchPhase = proxy ? 'ttfb' : 'connect'
    const onRes = (res: http.IncomingMessage): void => {
      if (timer) clearTimeout(timer)
      // 响应阶段错误（含主动销毁）走统一拒绝；连接类底层错误在此换成可行动文案
      res.on('error', (e) => reject(wrapConnectionError(e, phase)))
      resolve({ req, res })
    }
    const options: http.RequestOptions = proxy
      ? {
          method,
          host: u.hostname,
          port,
          path: u.pathname + u.search,
          headers: reqHeaders,
          agent: new TunnelAgent(() => tunnel!)
        }
      : {
          method,
          host: ip,
          port,
          path: u.pathname + u.search,
          headers: reqHeaders,
          ...(isHttps ? { servername: u.hostname } : {})
        }
    const req = proxy
      ? http.request(options, onRes)
      : isHttps
        ? https.request(options, onRes)
        : http.request(options, onRes)
    // P0-5：只在这里加一——请求对象已建好，是真正会出网的调用（重定向的每一跳都会经过）。
    outboundRequestCount++
    if (!proxy) {
      req.on('socket', (socket) => {
        if (!socket.connecting) {
          phase = 'ttfb'
          return
        }
        if (isHttps) {
          socket.once('connect', () => {
            phase = 'tls'
          })
          socket.once('secureConnect', () => {
            phase = 'ttfb'
          })
        } else {
          socket.once('connect', () => {
            phase = 'ttfb'
          })
        }
      })
    }
    let timer: NodeJS.Timeout | undefined
    timer = setTimeout(() => {
      req.destroy(new SafeFetchError(phaseTimeoutMessage(phase), phase))
      if (tunnel) tunnel.destroy()
    }, remaining)
    onRequest(req)
    req.on('error', (e) => {
      if (timer) clearTimeout(timer)
      if (tunnel) tunnel.destroy()
      reject(wrapConnectionError(e, phase))
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
      req.destroy(new SafeFetchError(phaseTimeoutMessage('body'), 'body'))
    }, Math.max(remaining, 1))

    // sink 模式：边收边写文件，避免数百 MB 响应整体进内存
    if (sink) {
      const declaredTotal = Number.isFinite(declared) && declared > 0 ? declared : null
      const fileStream = fs.createWriteStream(sink.file)
      let received = 0
      let lastReport = 0
      const fail = (err: unknown) => {
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
        fail(wrapConnectionError(e, 'body'))
      })
      req.on('error', (e) => {
        clearTimeout(timer)
        fail(wrapConnectionError(e, 'body'))
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
      reject(wrapConnectionError(e, 'body'))
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(wrapConnectionError(e, 'body'))
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
 * 307/308 保留原方法与 body；跨 origin 自动剥离凭据头（Authorization/Cookie/...），
 * 除非调用方显式打开 allowCredentialForwarding（会留审计告警）。
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
  const dnsTimeoutMs = opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS
  // 代理只在调用点显式打开时解析；坏配置解析失败→null→直连，不阻断出网
  const proxySetting = opts.useProxy ? parseProxyConfig(proxyResolver?.()) : null
  let currentReq: http.ClientRequest | null = null
  const onAbort = () => {
    currentReq?.destroy(new SafeFetchError('已中止'))
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  // 重定向时可能降级方法/丢弃 body，用可变副本；凭据头也在跨 origin 时可变
  let method = (opts.method ?? 'GET').toUpperCase()
  let body: string | Buffer | undefined = opts.body
  let requestHeaders: Record<string, string> = { ...(opts.headers ?? {}) }

  try {
    for (let hop = 0; ; hop++) {
      if (signal?.aborted) throw new SafeFetchError('已中止')
      assertFetchable(current)
      // 只对用户显式确认的那一个精确 origin 放行私网；重定向换了 origin 即失效
      const allowPrivate = !!opts.allowPrivateOrigin && current.origin === opts.allowPrivateOrigin
      const ip = await resolveAndValidate(current, allowPrivate, dnsTimeoutMs, deadline)
      if (signal?.aborted) throw new SafeFetchError('已中止')
      // 本机目标与 allowPrivateOrigin 强制直连：访私网的语义不能被代理改写
      const proxy =
        proxySetting && !allowPrivate && !isPrivateHostname(current.hostname) ? proxySetting : null

      const { req, res } = await requestOnce(
        current,
        ip,
        method,
        body,
        requestHeaders,
        deadline,
        (r) => {
          currentReq = r
        },
        proxy,
        signal
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
        // M3：跨 origin 自动剥离凭据；默认关闭显式转发，打开时留审计告警
        if (next.origin !== current.origin) {
          if (opts.allowCredentialForwarding === true) {
            console.warn(`[safeFetch] 凭据头跨 origin 转发已显式允许: ${current.origin} -> ${next.origin}`)
          } else {
            const stripped = stripCredentialHeaders(requestHeaders)
            if (stripped.length > 0) {
              console.warn(`[safeFetch] 跨域重定向已剥离凭据头: ${stripped.join(',')} (${current.origin} -> ${next.origin})`)
            }
          }
        }
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
