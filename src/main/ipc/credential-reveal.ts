// 凭据 reveal 的单次令牌 + 冷却（SEC-16-11）
//
// 诚实说明威胁模型：令牌由「渲染层可自行调用」的新 IPC 签发，被注入的渲染层同样能取到
// 令牌再走 reveal——所以 token 本身**不是**主防线。它防的是两类现实问题：
// ① 重放/误用：一次「显示密钥」点击对应一个用后即焚的句柄（消费一次即失效、TTL 60s），
//   截图/日志/内存里残存的 token 无法被再次兑换成密钥；
// ② 批量脚本化：同一 id 60s 冷却把「循环遍历导出全部凭据」的速率压到每次一条，
//   给用户/审计留出可感知的窗口。
// 真正的主防线是两件：security_events 的 credential_reveal 审计留痕（每次成功 reveal 一条，
// 不含密钥值）＋ 锁屏网关（APP_LOCKED）对整条通道的 fail-closed 拦截。
//
// 纯内存实现、无 electron 依赖：模块级 Map + 可导出纯函数，handlers 直测与单测共用同一份语义。
import { randomBytes } from 'node:crypto'
import type { SecurityEventKind } from '../db/repositories/security-event.repo'

/**
 * SEC-16-11 的审计 kind。已由 security-event.repo 的 SecurityEventKind 联合正式收编，
 * 这里保留常量供 handlers 与测试共用同一个字面量（不再靠 as 断言绕过类型）。
 */
export const CREDENTIAL_REVEAL_KIND: SecurityEventKind = 'credential_reveal'

const TOKEN_TTL_MS = 60_000
const COOLDOWN_MS = 60_000
/** 同时存活的令牌上限（正常用量每次一条，防被滥用成无限缓存） */
const MAX_TOKENS = 50

export type RevealChannel = 'provider' | 'mcp'

const tokens = new Map<string, { channel: RevealChannel; at: number }>()
/** key = `${channel}:${id}` → 上次成功 reveal 的时刻 */
const lastRevealAt = new Map<string, number>()

function pruneExpired(now: number): void {
  for (const [token, entry] of tokens) {
    if (now - entry.at > TOKEN_TTL_MS) tokens.delete(token)
  }
}

/** 签发单次令牌：随机句柄，消费一次即失效，TTL 60s */
export function issueRevealToken(channel: RevealChannel): string {
  const now = Date.now()
  pruneExpired(now)
  while (tokens.size >= MAX_TOKENS) {
    const oldest = tokens.keys().next().value
    if (oldest === undefined) break
    tokens.delete(oldest)
  }
  const token = randomBytes(24).toString('hex')
  tokens.set(token, { channel, at: now })
  return token
}

/** 消费令牌：正确且未过期才通过，**通过即删除**（无论后续业务成败都不许重放） */
export function consumeRevealToken(channel: RevealChannel, token: unknown): boolean {
  if (typeof token !== 'string' || !token) return false
  const entry = tokens.get(token)
  if (!entry) return false
  tokens.delete(token)
  if (entry.channel !== channel) return false
  if (Date.now() - entry.at > TOKEN_TTL_MS) return false
  return true
}

/** 冷却判定：true = 允许（该 id 距上次成功 reveal 已超 60s） */
export function revealCooldownOk(channel: RevealChannel, id: string, now = Date.now()): boolean {
  const last = lastRevealAt.get(`${channel}:${id}`)
  if (last === undefined) return true
  return now - last >= COOLDOWN_MS
}

/** 成功 reveal 后记账（只由业务侧在真正返回密钥前调用） */
export function markRevealDone(channel: RevealChannel, id: string, now = Date.now()): void {
  lastRevealAt.set(`${channel}:${id}`, now)
}

/** 测试用：清空全部状态 */
export function resetRevealGuardForTest(): void {
  tokens.clear()
  lastRevealAt.clear()
}
