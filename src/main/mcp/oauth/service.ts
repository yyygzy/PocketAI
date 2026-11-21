// 远程 MCP OAuth 授权服务（主进程单例）。
//
// 目标：补齐「远程 MCP 只能填静态 Headers」的缺口，同时保持项目现有安全口径：
//  · 授权码 + PKCE S256 + state + 127.0.0.1 回环回调；
//  · 动态客户端注册（DCR），服务端不支持时可手动填预注册 client_id/secret；
//  · token 刷新单飞；401/invalid_grant → needs_reauth，界面给人话与重试入口；
//  · token / client_secret 只经仓储字段级加密落库，不出 IPC、不进日志；
//  · 未设主密码（none 模式）拒绝持久化任何凭据。
import { createLogger } from '../../logger'
import { errMsg } from '../../error'
import { mcpServerRepo } from '../../db/repositories/mcp-server.repo'
import { mcpOauthRepo, type McpOauthRecord } from '../../db/repositories/mcp-oauth.repo'
import { openExternalSecure } from '../../net/external-links'
import { readTextLimited } from '../../net/bounded-read'
import { safeFetchLike } from '../../net/fetch-like'
import {
  oauthEndpointProblem,
  isOpenableOauthUrl,
  type McpOauthManualConfig,
  type McpOauthStatus,
  type McpOauthView
} from '../../../shared/mcp-oauth'
import type { McpServerRecord } from '../../../shared/types'
import { OAuthLoopbackServer } from './loopback'
import { createOauthState, createPkcePair, safeStateEqual } from './pkce'
import { discoverOauthConfig } from './discovery'
import {
  humanizeOauthError,
  McpOauthAuthRequiredError,
  parseOauthErrorCode,
  oauthCodeMessage
} from './errors'

const log = createLogger('mcp')

const TOKEN_TIMEOUT_MS = 15_000
const MAX_TOKEN_BODY_BYTES = 256 * 1024
const EXPIRY_LEEWAY_MS = 60_000

export interface McpOauthServiceDeps {
  getServer: (id: string) => McpServerRecord | null
  repo: typeof mcpOauthRepo
  fetchImpl: typeof fetch
  openUrl: (url: string) => void
  now: () => number
  onStatus?: (view: McpOauthView | null) => void
}

interface ResolvedConfig {
  issuer: string | null
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint: string | null
  revocationEndpoint: string | null
  scope: string | null
  clientId: string | null
  clientSecret: string
  tokenEndpointAuthMethod: string | null
}

interface PendingAuth {
  serverId: string
  state: string
  verifier: string
  challenge: string
  redirectUri: string
  loopback: OAuthLoopbackServer
  config: ResolvedConfig
}

class OauthTokenError extends Error {
  readonly oauthCode: string | null
  constructor(code: string | null, message: string) {
    super(message)
    this.name = 'OauthTokenError'
    this.oauthCode = code
  }
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function asNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : null
}

async function readJsonResponse(res: Response, label: string): Promise<unknown> {
  // M4：流式有界读取，超限立即取消，不先把整段响应读进内存
  const text = await readTextLimited(res, MAX_TOKEN_BODY_BYTES, label)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`${label}返回的不是合法 JSON。`)
  }
}

export class McpOauthService {
  private readonly deps: McpOauthServiceDeps
  private readonly pending = new Map<string, PendingAuth>()
  private readonly refreshing = new Map<string, Promise<void>>()

  constructor(deps?: Partial<McpOauthServiceDeps>) {
    this.deps = {
      getServer: deps?.getServer ?? ((id) => mcpServerRepo.get(id)),
      repo: deps?.repo ?? mcpOauthRepo,
      fetchImpl: deps?.fetchImpl ?? safeFetchLike,
      openUrl: deps?.openUrl ?? openExternalSecure,
      now: deps?.now ?? (() => Date.now()),
      onStatus: deps?.onStatus
    }
  }

  /** 接线方（IPC 注册时）注入状态广播；只传脱敏视图，不带 token */
  setOnStatus(cb: ((view: McpOauthView | null) => void) | undefined): void {
    this.deps.onStatus = cb
  }

  getView(serverId: string): McpOauthView | null {
    return this.deps.repo.getView(serverId)
  }

  listViews(): McpOauthView[] {
    return this.deps.repo.listViews()
  }

  /** 发起授权。返回时浏览器已打开；完成/失败通过状态视图与 onStatus 反映。 */
  async beginAuth(serverId: string, manual?: McpOauthManualConfig): Promise<void> {
    const record = this.deps.getServer(serverId)
    if (!record) throw new Error('这个连接器已被删除或不存在。')
    if (record.transport !== 'http' || !record.url) {
      throw new Error('只有远程（HTTP）连接器才需要 OAuth 授权。')
    }
    if (record.authMode !== 'oauth') {
      throw new Error('请先把鉴权方式切换为「OAuth」并保存，再发起授权。')
    }
    // 同一 server 同时只允许一个授权流程；重新发起会取消旧的等待
    const old = this.pending.get(serverId)
    if (old) {
      old.loopback.cancel('已发起新的授权，旧的等待已取消。')
      this.pending.delete(serverId)
    }

    const existing = this.deps.repo.get(serverId)
    const config = await this.resolveConfig(record, manual, existing)
    const state = createOauthState()
    const pkce = createPkcePair()
    const loopback = new OAuthLoopbackServer(state)
    try {
      await loopback.start()
      const redirectUri = loopback.redirectUri
      // 没有 client_id 才走 DCR；服务端不支持时给出可操作的错误
      if (!config.clientId) {
        const registered = await this.registerClient(config, redirectUri)
        config.clientId = registered.clientId
        if (registered.clientSecret) config.clientSecret = registered.clientSecret
        config.tokenEndpointAuthMethod =
          registered.tokenEndpointAuthMethod ??
          config.tokenEndpointAuthMethod ??
          (registered.clientSecret ? 'client_secret_basic' : 'none')
      }
      const authUrl = this.buildAuthorizationUrl(config, redirectUri, state, pkce.challenge)
      if (!isOpenableOauthUrl(authUrl)) throw new Error('授权地址不合法，已拒绝打开。')
      const pending: PendingAuth = {
        serverId,
        state,
        verifier: pkce.verifier,
        challenge: pkce.challenge,
        redirectUri,
        loopback,
        config
      }
      this.pending.set(serverId, pending)
      this.deps.openUrl(authUrl)
      void this.finishAuthorization(pending)
    } catch (e) {
      loopback.close()
      this.pending.delete(serverId)
      const friendly = humanizeOauthError(e)
      this.recordFailure(serverId, friendly, existing)
      throw new Error(friendly)
    }
  }

  /** 用户取消等待中的授权；已授权状态不被破坏 */
  cancelAuth(serverId: string): void {
    const pending = this.pending.get(serverId)
    if (!pending) return
    pending.loopback.cancel('授权已取消。')
    this.pending.delete(serverId)
  }

  /** 应用退出/停用连接器时清理所有等待中的回环服务 */
  dispose(): void {
    for (const p of this.pending.values()) p.loopback.cancel('应用正在退出，授权已取消。')
    this.pending.clear()
  }

  /**
   * 给 HTTP 传输注入 Authorization 头。
   * 过期前 60 秒主动刷新；状态非 authorized 时先尝试 refresh（若仍有 refresh token），
   * 刷新失败抛人话，界面据此显示「需重新授权」。
   */
  async getAuthorizationHeader(serverId: string): Promise<string> {
    let rec = this.deps.repo.get(serverId)
    if (!rec) throw new McpOauthAuthRequiredError('这个连接器还没有授权。请点「去授权」后再启动。')
    const expired =
      rec.expiresAt !== null && rec.expiresAt > 0 && rec.expiresAt - EXPIRY_LEEWAY_MS <= this.deps.now()
    if (rec.status !== 'authorized' || expired) {
      if (rec.refreshToken) {
        await this.refresh(serverId)
        rec = this.deps.repo.get(serverId)
      } else if (expired) {
        const msg = '授权已过期，请点「重新授权」后再试。'
        this.markNeedsReauth(serverId, msg)
        throw new McpOauthAuthRequiredError(msg)
      } else {
        throw new McpOauthAuthRequiredError(rec.lastError ?? undefined)
      }
    }
    if (!rec?.accessToken) {
      const msg = '授权凭据不可用，请点「重新授权」后再试。'
      this.markNeedsReauth(serverId, msg)
      throw new McpOauthAuthRequiredError(msg)
    }
    return `Bearer ${rec.accessToken}`
  }

  /** 收到 401/403 时由 manager 调用：标记需重新授权，不自动弹浏览器 */
  markUnauthorized(serverId: string): void {
    const msg = '服务端拒绝了当前登录状态，请点「重新授权」后再试。'
    this.markNeedsReauth(serverId, msg)
  }

  markNeedsReauth(serverId: string, message: string): void {
    try {
      this.deps.repo.updateStatus(serverId, 'needs_reauth', message)
      this.emit(serverId)
    } catch (e) {
      log.warn(`标记 OAuth 状态失败 ${serverId}: ${errMsg(e)}`)
    }
  }

  /** 用户主动清除授权：本地立即删除；服务端 revocation 尽力而为，不影响本地结果 */
  async clear(serverId: string): Promise<void> {
    const rec = this.deps.repo.get(serverId)
    this.deps.repo.clear(serverId)
    this.emit(serverId)
    if (rec?.revocationEndpoint && (rec.accessToken || rec.refreshToken)) {
      void this.revokeRemote(rec).catch(() => {
        /* 服务端撤销失败不回滚本地清除 */
      })
    }
  }

  /** 刷新 access token（单飞） */
  async refresh(serverId: string): Promise<void> {
    const inflight = this.refreshing.get(serverId)
    if (inflight) return inflight
    const task = this.doRefresh(serverId).finally(() => {
      this.refreshing.delete(serverId)
    })
    this.refreshing.set(serverId, task)
    return task
  }

  private async doRefresh(serverId: string): Promise<void> {
    const rec = this.deps.repo.get(serverId)
    if (!rec || !rec.tokenEndpoint || !rec.clientId || !rec.refreshToken) {
      const msg = '授权已失效，请点「重新授权」后再试。'
      this.markNeedsReauth(serverId, msg)
      throw new McpOauthAuthRequiredError(msg)
    }
    try {
      const body = await this.postToken(rec, {
        grant_type: 'refresh_token',
        refresh_token: rec.refreshToken,
        client_id: rec.clientId
      })
      const accessToken = asString(body.access_token)
      if (!accessToken) throw new OauthTokenError(null, '授权服务器没有返回 access_token。')
      const expiresIn = asNumber(body.expires_in)
      this.deps.repo.save({
        serverId,
        accessToken,
        ...(asString(body.refresh_token) ? { refreshToken: asString(body.refresh_token) } : {}),
        tokenType: asString(body.token_type) ?? rec.tokenType,
        scope: asString(body.scope) ?? rec.scope,
        expiresAt: expiresIn !== null ? this.deps.now() + expiresIn * 1000 : rec.expiresAt,
        status: 'authorized',
        lastError: null
      })
      this.emit(serverId)
      log.info(`OAuth token 已刷新: ${serverId}`)
    } catch (e) {
      const code = e instanceof OauthTokenError ? e.oauthCode : null
      const permanent =
        code === 'invalid_grant' ||
        code === 'invalid_client' ||
        code === 'unauthorized_client' ||
        code === 'invalid_scope' ||
        code === 'invalid_token' ||
        code === 'access_denied'
      const friendly = oauthCodeMessage(code) ?? humanizeOauthError(e)
      // 永久性失败清掉已失效 token；网络/5xx 保留，便于下次重试
      this.deps.repo.save({
        serverId,
        ...(permanent ? { accessToken: '', refreshToken: '' } : {}),
        status: permanent ? 'needs_reauth' : 'error',
        lastError: friendly
      })
      this.emit(serverId)
      log.warn(`OAuth 刷新失败 ${serverId}: ${code ?? friendly}`)
      throw new Error(friendly)
    }
  }

  private emit(serverId: string): void {
    this.deps.onStatus?.(this.deps.repo.getView(serverId))
  }

  private recordFailure(
    serverId: string,
    message: string,
    existing?: McpOauthRecord | null
  ): void {
    try {
      // 没有 secret 的失败状态可以落库（none 模式下也允许），UI 才能显示原因与重试
      this.deps.repo.save({
        serverId,
        ...(existing
          ? {
              issuer: existing.issuer,
              authorizationEndpoint: existing.authorizationEndpoint,
              tokenEndpoint: existing.tokenEndpoint,
              registrationEndpoint: existing.registrationEndpoint,
              revocationEndpoint: existing.revocationEndpoint
            }
          : {}),
        status: 'error',
        lastError: message
      })
      this.emit(serverId)
    } catch (e) {
      log.warn(`记录 OAuth 失败状态失败 ${serverId}: ${errMsg(e)}`)
    }
  }

  private async resolveConfig(
    record: McpServerRecord,
    manual: McpOauthManualConfig | undefined,
    existing: McpOauthRecord | null
  ): Promise<ResolvedConfig> {
    const m = manual ?? {}
    for (const [value, label] of [
      [m.authorizationEndpoint, '授权端点'],
      [m.tokenEndpoint, '令牌端点'],
      [m.registrationEndpoint, '注册端点'],
      [m.revocationEndpoint, '撤销端点']
    ] as const) {
      if (value) {
        const problem = oauthEndpointProblem(value, label)
        if (problem) throw new Error(problem)
      }
    }
    let issuer = m.issuer ?? existing?.issuer ?? null
    let authorizationEndpoint = m.authorizationEndpoint ?? existing?.authorizationEndpoint ?? null
    let tokenEndpoint = m.tokenEndpoint ?? existing?.tokenEndpoint ?? null
    let registrationEndpoint = m.registrationEndpoint ?? existing?.registrationEndpoint ?? null
    let revocationEndpoint = m.revocationEndpoint ?? existing?.revocationEndpoint ?? null
    let scope = m.scope ?? existing?.scope ?? null
    let discovered: Awaited<ReturnType<typeof discoverOauthConfig>> | null = null

    if (!authorizationEndpoint || !tokenEndpoint) {
      discovered = await discoverOauthConfig(record.url!, this.deps.fetchImpl)
      issuer = issuer ?? discovered.issuer
      authorizationEndpoint = authorizationEndpoint ?? discovered.authorizationEndpoint
      tokenEndpoint = tokenEndpoint ?? discovered.tokenEndpoint
      registrationEndpoint = registrationEndpoint ?? discovered.registrationEndpoint
      revocationEndpoint = revocationEndpoint ?? discovered.revocationEndpoint
      scope = scope ?? discovered.scope
    }
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error('缺少授权端点或令牌端点，请展开高级设置手动填写。')
    }
    if (!issuer && discovered) issuer = discovered.issuer
    const problem =
      oauthEndpointProblem(authorizationEndpoint, '授权端点') ??
      oauthEndpointProblem(tokenEndpoint, '令牌端点') ??
      (registrationEndpoint ? oauthEndpointProblem(registrationEndpoint, '注册端点') : null) ??
      (revocationEndpoint ? oauthEndpointProblem(revocationEndpoint, '撤销端点') : null)
    if (problem) throw new Error(problem)

    return {
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      revocationEndpoint,
      scope,
      clientId: m.clientId ?? existing?.clientId ?? null,
      clientSecret: m.clientSecret ?? existing?.clientSecret ?? '',
      tokenEndpointAuthMethod: existing?.tokenEndpointAuthMethod ?? null
    }
  }

  private async registerClient(
    config: ResolvedConfig,
    redirectUri: string
  ): Promise<{ clientId: string; clientSecret: string | null; tokenEndpointAuthMethod: string | null }> {
    if (!config.registrationEndpoint) {
      throw new Error(
        '该授权服务器没有提供动态注册端点。请展开高级设置，填写服务端预注册的 client_id（如有 client_secret 一并填写）。'
      )
    }
    const problem = oauthEndpointProblem(config.registrationEndpoint, '注册端点')
    if (problem) throw new Error(problem)
    let res: Response
    try {
      res = await this.deps.fetchImpl(config.registrationEndpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_name: 'PocketAI',
          redirect_uris: [redirectUri],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          ...(config.scope ? { scope: config.scope } : {})
        }),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
      })
    } catch (e) {
      throw new Error(`动态客户端注册失败：${errMsg(e)}`)
    }
    const body = await readJsonResponse(res, '动态注册')
    if (!res.ok) {
      const code = parseOauthErrorCode(body)
      throw new Error(
        `动态客户端注册被拒绝${code ? `（${oauthCodeMessage(code) ?? code}）` : ''}。请手动填写预注册的 client_id/client_secret。`
      )
    }
    const clientId = body && typeof body === 'object' ? asString((body as Record<string, unknown>).client_id) : null
    if (!clientId) throw new Error('动态客户端注册没有返回 client_id，请手动填写预注册客户端。')
    const obj = body as Record<string, unknown>
    return {
      clientId,
      clientSecret: asString(obj.client_secret),
      tokenEndpointAuthMethod: asString(obj.token_endpoint_auth_method)
    }
  }

  private buildAuthorizationUrl(
    config: ResolvedConfig,
    redirectUri: string,
    state: string,
    challenge: string
  ): string {
    const problem = oauthEndpointProblem(config.authorizationEndpoint, '授权端点')
    if (problem) throw new Error(problem)
    if (!config.clientId) throw new Error('缺少 client_id，无法发起授权。')
    const u = new URL(config.authorizationEndpoint)
    u.searchParams.set('response_type', 'code')
    u.searchParams.set('client_id', config.clientId)
    u.searchParams.set('redirect_uri', redirectUri)
    u.searchParams.set('state', state)
    u.searchParams.set('code_challenge', challenge)
    u.searchParams.set('code_challenge_method', 'S256')
    if (config.scope) u.searchParams.set('scope', config.scope)
    return u.toString()
  }

  private async finishAuthorization(pending: PendingAuth): Promise<void> {
    const { serverId } = pending
    try {
      const result = await pending.loopback.waitForCode()
      if (!safeStateEqual(result.state, pending.state)) {
        throw new Error('授权回调状态不匹配，请重新授权。')
      }
      const body = await this.postToken(pending.config, {
        grant_type: 'authorization_code',
        code: result.code,
        redirect_uri: pending.redirectUri,
        client_id: pending.config.clientId ?? '',
        code_verifier: pending.verifier
      })
      const accessToken = asString(body.access_token)
      if (!accessToken) throw new OauthTokenError(null, '授权服务器没有返回 access_token。')
      const expiresIn = asNumber(body.expires_in)
      const cfg = pending.config
      this.deps.repo.save({
        serverId,
        issuer: cfg.issuer,
        authorizationEndpoint: cfg.authorizationEndpoint,
        tokenEndpoint: cfg.tokenEndpoint,
        registrationEndpoint: cfg.registrationEndpoint,
        revocationEndpoint: cfg.revocationEndpoint,
        clientId: cfg.clientId,
        clientSecret: cfg.clientSecret || undefined,
        tokenEndpointAuthMethod: cfg.tokenEndpointAuthMethod,
        accessToken,
        ...(asString(body.refresh_token) ? { refreshToken: asString(body.refresh_token) } : {}),
        tokenType: asString(body.token_type) ?? 'Bearer',
        scope: asString(body.scope) ?? cfg.scope,
        expiresAt: expiresIn !== null ? this.deps.now() + expiresIn * 1000 : null,
        status: 'authorized',
        lastError: null
      })
      this.emit(serverId)
      log.info(`OAuth 授权完成: ${serverId}`)
    } catch (e) {
      const code = e instanceof OauthTokenError ? e.oauthCode : null
      const friendly = oauthCodeMessage(code) ?? humanizeOauthError(e)
      this.recordFailure(serverId, friendly)
      log.warn(`OAuth 授权失败 ${serverId}: ${code ?? friendly}`)
    } finally {
      pending.loopback.close()
      this.pending.delete(serverId)
    }
  }

  private async postToken(
    rec: Pick<McpOauthRecord, 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'tokenEndpointAuthMethod'>,
    params: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const tokenEndpoint = rec.tokenEndpoint
    if (!tokenEndpoint) throw new Error('缺少令牌端点，请重新授权。')
    const problem = oauthEndpointProblem(tokenEndpoint, '令牌端点')
    if (problem) throw new Error(problem)
    const form = new URLSearchParams(params)
    let authorization: string | null = null
    const method = rec.tokenEndpointAuthMethod ?? (rec.clientSecret ? 'client_secret_basic' : 'none')
    if (method === 'client_secret_post' && rec.clientSecret) {
      form.set('client_secret', rec.clientSecret)
    } else if (method === 'client_secret_basic' && rec.clientSecret) {
      const basic = `${encodeURIComponent(rec.clientId ?? '')}:${encodeURIComponent(rec.clientSecret)}`
      authorization = `Basic ${Buffer.from(basic).toString('base64')}`
    }
    let res: Response
    try {
      res = await this.deps.fetchImpl(tokenEndpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...(authorization ? { Authorization: authorization } : {})
        },
        body: form.toString(),
        signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
      })
    } catch (e) {
      throw new Error(`连接令牌端点失败：${errMsg(e)}`)
    }
    const body = await readJsonResponse(res, '令牌端点')
    const code = res.ok ? null : parseOauthErrorCode(body)
    if (!res.ok) {
      throw new OauthTokenError(
        code,
        `令牌端点请求失败（HTTP ${res.status}）${code ? `：${oauthCodeMessage(code) ?? code}` : ''}`
      )
    }
    if (!body || typeof body !== 'object') throw new OauthTokenError(null, '令牌端点返回格式不正确。')
    const obj = body as Record<string, unknown>
    if (obj.error) {
      throw new OauthTokenError(asString(obj.error), oauthCodeMessage(asString(obj.error)) ?? '授权失败。')
    }
    return obj
  }

  private async revokeRemote(rec: McpOauthRecord): Promise<void> {
    if (!rec.revocationEndpoint) return
    const problem = oauthEndpointProblem(rec.revocationEndpoint, '撤销端点')
    if (problem) return
    const token = rec.refreshToken || rec.accessToken
    if (!token) return
    const form = new URLSearchParams({
      token,
      token_type_hint: rec.refreshToken ? 'refresh_token' : 'access_token',
      client_id: rec.clientId ?? ''
    })
    if (rec.clientSecret) {
      form.set('client_secret', rec.clientSecret)
    }
    await this.deps.fetchImpl(rec.revocationEndpoint, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS)
    })
  }
}

/** 主进程共享单例；状态变更由接线方注入 onStatus 广播给渲染层 */
export const mcpOauthService = new McpOauthService()

/** 把状态改为「需重新授权」的便捷函数（供 manager/错误路径调用） */
export function markOauthNeedsReauth(serverId: string, message: string): void {
  mcpOauthService.markNeedsReauth(serverId, message)
}

export type { McpOauthStatus }
