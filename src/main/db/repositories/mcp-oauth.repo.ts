// MCP OAuth 凭据仓储（v78）。
//
// 安全：
//  · client_secret / access_token / refresh_token 三列只以字段级密文落盘（encryptSecret）；
//  · 未设主密码（none 模式）时拒绝写入任何 token/secret（固定混淆密钥等同明文）；
//  · 出 IPC 只走 getView/listViews：不含任何密文或明文 token；
//  · 主密码轮换由 credential-rotation 调 exportAllSecrets/restoreAllSecrets。
import { dbService } from '../database'
import {
  encryptSecret,
  decryptSecret,
  isCipherText,
  hasUndecryptableCipher
} from '../../crypto/field-encrypt'
import { isNoneMode, NONE_MODE_HINT } from '../../crypto/none-mode-gate'
import { errMsg } from '../../error'
import { createLogger } from '../../logger'
import type { McpOauthStatus, McpOauthView } from '../../../shared/mcp-oauth'

const log = createLogger('crypto')

interface OauthRow {
  server_id: string
  issuer: string | null
  authorization_endpoint: string | null
  token_endpoint: string | null
  registration_endpoint: string | null
  revocation_endpoint: string | null
  client_id: string | null
  client_secret_enc: string | null
  token_endpoint_auth_method: string | null
  access_token_enc: string | null
  refresh_token_enc: string | null
  token_type: string | null
  scope: string | null
  expires_at: number | null
  status: string | null
  last_error: string | null
  updated_at: number | null
}

export interface McpOauthRecord {
  serverId: string
  issuer: string | null
  authorizationEndpoint: string | null
  tokenEndpoint: string | null
  registrationEndpoint: string | null
  revocationEndpoint: string | null
  clientId: string | null
  clientSecret: string
  tokenEndpointAuthMethod: string | null
  accessToken: string
  refreshToken: string
  tokenType: string | null
  scope: string | null
  expiresAt: number | null
  status: McpOauthStatus
  lastError: string | null
  updatedAt: number
}

export interface McpOauthSaveInput {
  serverId: string
  issuer?: string | null
  authorizationEndpoint?: string | null
  tokenEndpoint?: string | null
  registrationEndpoint?: string | null
  revocationEndpoint?: string | null
  clientId?: string | null
  clientSecret?: string | null
  tokenEndpointAuthMethod?: string | null
  accessToken?: string | null
  refreshToken?: string | null
  tokenType?: string | null
  scope?: string | null
  expiresAt?: number | null
  status?: McpOauthStatus
  lastError?: string | null
}

function normalizeStatus(v: unknown): McpOauthStatus {
  return v === 'authorized' || v === 'needs_reauth' || v === 'error' ? v : 'needs_reauth'
}

function rowToRecord(row: OauthRow): McpOauthRecord {
  return {
    serverId: row.server_id,
    issuer: row.issuer,
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    registrationEndpoint: row.registration_endpoint,
    revocationEndpoint: row.revocation_endpoint,
    clientId: row.client_id,
    clientSecret: decryptSecret(row.client_secret_enc),
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    accessToken: decryptSecret(row.access_token_enc),
    refreshToken: decryptSecret(row.refresh_token_enc),
    tokenType: row.token_type,
    scope: row.scope,
    expiresAt: row.expires_at ?? null,
    status: normalizeStatus(row.status),
    lastError: row.last_error,
    updatedAt: row.updated_at ?? 0
  }
}

function rowToView(row: OauthRow): McpOauthView {
  return {
    serverId: row.server_id,
    status: normalizeStatus(row.status),
    issuer: row.issuer,
    scope: row.scope,
    expiresAt: row.expires_at ?? null,
    // 只看落盘是否非空，不解密：视图不携带任何秘密
    hasRefreshToken: !!row.refresh_token_enc,
    lastError: row.last_error,
    updatedAt: row.updated_at ?? 0
  }
}

function assertPersistAllowed(input: McpOauthSaveInput): void {
  if (!isNoneMode()) return
  const hasSecret = [input.clientSecret, input.accessToken, input.refreshToken].some(
    (v) => typeof v === 'string' && v.length > 0
  )
  if (hasSecret) {
    throw new Error(`未设置主密码，OAuth 凭据不会被保存。${NONE_MODE_HINT}`)
  }
}

export const mcpOauthRepo = {
  get(serverId: string): McpOauthRecord | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM mcp_oauth_credentials WHERE server_id=?')
      .get(serverId) as OauthRow | undefined
    return row ? rowToRecord(row) : null
  },

  getView(serverId: string): McpOauthView | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT * FROM mcp_oauth_credentials WHERE server_id=?')
      .get(serverId) as OauthRow | undefined
    return row ? rowToView(row) : null
  },

  listViews(): McpOauthView[] {
    const rows = dbService
      .getHandle()
      .prepare('SELECT * FROM mcp_oauth_credentials ORDER BY updated_at DESC')
      .all() as OauthRow[]
    return rows.map(rowToView)
  },

  /** 合并保存：未提交的字段沿用旧值；三列秘密只在有值时重新加密 */
  save(input: McpOauthSaveInput): McpOauthRecord {
    assertPersistAllowed(input)
    const existing = this.get(input.serverId)
    const pick = <T>(next: T | undefined, prev: T | null | undefined, fallback: T): T =>
      next !== undefined ? next : (prev ?? fallback)
    // 秘密字段允许显式传空串（登出/撤销时清空）；null/undefined 都视为沿用旧值
    const secretOf = (next: string | null | undefined, prev: string | null | undefined): string =>
      next !== undefined && next !== null ? next : (prev ?? '')
    const clientSecret = secretOf(input.clientSecret, existing?.clientSecret)
    const accessToken = secretOf(input.accessToken, existing?.accessToken)
    const refreshToken = secretOf(input.refreshToken, existing?.refreshToken)
    const now = Date.now()
    const values = {
      issuer: pick(input.issuer, existing?.issuer, null),
      authorizationEndpoint: pick(input.authorizationEndpoint, existing?.authorizationEndpoint, null),
      tokenEndpoint: pick(input.tokenEndpoint, existing?.tokenEndpoint, null),
      registrationEndpoint: pick(input.registrationEndpoint, existing?.registrationEndpoint, null),
      revocationEndpoint: pick(input.revocationEndpoint, existing?.revocationEndpoint, null),
      clientId: pick(input.clientId, existing?.clientId, null),
      clientSecretEnc: encryptSecret(clientSecret),
      tokenEndpointAuthMethod: pick(
        input.tokenEndpointAuthMethod,
        existing?.tokenEndpointAuthMethod,
        null
      ),
      accessTokenEnc: encryptSecret(accessToken),
      refreshTokenEnc: encryptSecret(refreshToken),
      tokenType: pick(input.tokenType, existing?.tokenType, null),
      scope: pick(input.scope, existing?.scope, null),
      expiresAt: pick(input.expiresAt, existing?.expiresAt, null),
      status: normalizeStatus(pick(input.status, existing?.status, 'needs_reauth')),
      lastError: pick(input.lastError, existing?.lastError, null),
      updatedAt: now
    }
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO mcp_oauth_credentials
           (server_id, issuer, authorization_endpoint, token_endpoint, registration_endpoint, revocation_endpoint,
            client_id, client_secret_enc, token_endpoint_auth_method, access_token_enc, refresh_token_enc,
            token_type, scope, expires_at, status, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id) DO UPDATE SET
           issuer=excluded.issuer,
           authorization_endpoint=excluded.authorization_endpoint,
           token_endpoint=excluded.token_endpoint,
           registration_endpoint=excluded.registration_endpoint,
           revocation_endpoint=excluded.revocation_endpoint,
           client_id=excluded.client_id,
           client_secret_enc=excluded.client_secret_enc,
           token_endpoint_auth_method=excluded.token_endpoint_auth_method,
           access_token_enc=excluded.access_token_enc,
           refresh_token_enc=excluded.refresh_token_enc,
           token_type=excluded.token_type,
           scope=excluded.scope,
           expires_at=excluded.expires_at,
           status=excluded.status,
           last_error=excluded.last_error,
           updated_at=excluded.updated_at`
      )
      .run(
        input.serverId,
        values.issuer,
        values.authorizationEndpoint,
        values.tokenEndpoint,
        values.registrationEndpoint,
        values.revocationEndpoint,
        values.clientId,
        values.clientSecretEnc,
        values.tokenEndpointAuthMethod,
        values.accessTokenEnc,
        values.refreshTokenEnc,
        values.tokenType,
        values.scope,
        values.expiresAt,
        values.status,
        values.lastError,
        values.updatedAt
      )
    return this.get(input.serverId)!
  },

  updateStatus(serverId: string, status: McpOauthStatus, lastError: string | null): void {
    dbService
      .getHandle()
      .prepare('UPDATE mcp_oauth_credentials SET status=?, last_error=?, updated_at=? WHERE server_id=?')
      .run(status, lastError, Date.now(), serverId)
  },

  clear(serverId: string): void {
    dbService.getHandle().prepare('DELETE FROM mcp_oauth_credentials WHERE server_id=?').run(serverId)
  },

  countRows(): number {
    const row = dbService
      .getHandle()
      .prepare(
        "SELECT COUNT(*) AS n FROM mcp_oauth_credentials WHERE COALESCE(access_token_enc,'') <> '' OR COALESCE(refresh_token_enc,'') <> '' OR COALESCE(client_secret_enc,'') <> ''"
      )
      .get() as { n?: number } | undefined
    return row?.n ?? 0
  },

  /** 轮换前（旧字段密钥仍可用）：导出秘密明文快照，仅进程内存；解不开的行单列 undecryptable */
  exportAllSecrets(): {
    snapshot: Record<string, { clientSecret: string; accessToken: string; refreshToken: string }>
    undecryptable: string[]
  } {
    const rows = dbService
      .getHandle()
      .prepare(
        'SELECT server_id, client_secret_enc, access_token_enc, refresh_token_enc FROM mcp_oauth_credentials'
      )
      .all() as Array<{
      server_id: string
      client_secret_enc: string | null
      access_token_enc: string | null
      refresh_token_enc: string | null
    }>
    const snapshot: Record<
      string,
      { clientSecret: string; accessToken: string; refreshToken: string }
    > = {}
    const undecryptable: string[] = []
    for (const row of rows) {
      const clientSecret = decryptSecret(row.client_secret_enc)
      const accessToken = decryptSecret(row.access_token_enc)
      const refreshToken = decryptSecret(row.refresh_token_enc)
      if (clientSecret || accessToken || refreshToken) {
        snapshot[row.server_id] = { clientSecret, accessToken, refreshToken }
      } else if (
        hasUndecryptableCipher(row.client_secret_enc) ||
        hasUndecryptableCipher(row.access_token_enc) ||
        hasUndecryptableCipher(row.refresh_token_enc)
      ) {
        undecryptable.push(`oauth:${row.server_id}`)
      }
    }
    return { snapshot, undecryptable }
  },

  /** 轮换后（新字段密钥生效）：只重写三列秘密 */
  restoreAllSecrets(
    snapshot: Record<string, { clientSecret: string; accessToken: string; refreshToken: string }>
  ): void {
    const stmt = dbService
      .getHandle()
      .prepare(
        'UPDATE mcp_oauth_credentials SET client_secret_enc=?, access_token_enc=?, refresh_token_enc=? WHERE server_id=?'
      )
    for (const [serverId, secrets] of Object.entries(snapshot)) {
      try {
        stmt.run(
          encryptSecret(secrets.clientSecret),
          encryptSecret(secrets.accessToken),
          encryptSecret(secrets.refreshToken),
          serverId
        )
      } catch (e) {
        log.warn(`OAuth 凭据轮换恢复失败 ${serverId}: ${errMsg(e)}`)
      }
    }
  },

  /** 删除 MCP Server 时同步清理 OAuth 行（避免遗留 token） */
  deleteForServer(serverId: string): void {
    this.clear(serverId)
  },

  /** 调试/审计用：只判断某列是否为密文（不解密） */
  isEncrypted(value: string | null | undefined): boolean {
    return !!value && isCipherText(value)
  }
}
