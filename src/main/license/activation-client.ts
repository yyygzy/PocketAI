// 卡密在线激活客户端：把激活过程中所有失败路径归类为稳定的 ActivationErrorCode，
// 返回结构化 ActivationResult（IPC 结构化克隆会丢失 Error 自定义属性，故不抛业务错误）。
//
// 失败分类（小白可据此自助排障）：
//   - 本地问题：EMPTY_CODE / FINGERPRINT_UNAVAILABLE
//   - 网络问题：NETWORK_UNREACHABLE（断网/服务器没开/DNS）/ NETWORK_TIMEOUT
//   - 卡密问题：CODE_FORMAT_INVALID / CODE_NOT_FOUND / ALREADY_BOUND_OTHER / CODE_LOCKED
//   - 服务端问题：RATE_LIMITED / ISSUE_FAILED / SERVER_ERROR
//   - 安全问题：INVALID_LICENSE（下发 license 未通过本地验签/指纹比对）
import { ACTIVATION_BASE_URL } from './server-config'
import { licenseService } from './license'
import type { ActivationErrorCode, ActivationResult } from '../../shared/types'
import { isAbortError } from '../error'

const REQUEST_TIMEOUT_MS = 15_000

/** 服务端错误码 → 客户端错误码白名单（未知 code 一律按 SERVER_ERROR 处理） */
const SERVER_CODE_MAP: Record<string, ActivationErrorCode> = {
  RATE_LIMITED: 'RATE_LIMITED',
  CODE_LOCKED: 'CODE_LOCKED',
  CODE_FORMAT_INVALID: 'CODE_FORMAT_INVALID',
  CODE_NOT_FOUND: 'CODE_NOT_FOUND',
  ALREADY_BOUND_OTHER: 'ALREADY_BOUND_OTHER',
  FINGERPRINT_INVALID: 'FINGERPRINT_INVALID',
  ISSUE_FAILED: 'ISSUE_FAILED'
}

interface ServerErrorBody {
  ok?: boolean
  license?: string
  code?: string
  error?: string
}

function fail(code: ActivationErrorCode, detail?: string): ActivationResult {
  return detail ? { ok: false, code, detail } : { ok: false, code }
}

/**
 * 执行在线激活
 * @param codeInput 用户输入的卡密
 * @param fingerprint 本机硬盘指纹（IPC 层通过 getDiskFingerprint 取得并注入，便于测试）
 */
export async function activateOnline(
  codeInput: string,
  fingerprint: string | null
): Promise<ActivationResult> {
  const code = codeInput.trim()
  if (!code) return fail('EMPTY_CODE')
  if (!fingerprint) return fail('FINGERPRINT_UNAVAILABLE')

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${ACTIVATION_BASE_URL}/v1/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, fingerprint }),
      signal: ctrl.signal
    })
  } catch (e) {
    // AbortController 触发的中止 = 超时；其余 fetch 失败 = 连不上（拒绝连接/DNS/断网）
    if (isAbortError(e)) return fail('NETWORK_TIMEOUT')
    return fail('NETWORK_UNREACHABLE')
  } finally {
    clearTimeout(timer)
  }

  const data = (await res.json().catch(() => null)) as ServerErrorBody | null

  if (!res.ok || !data?.ok || typeof data.license !== 'string') {
    // 优先采信服务端稳定错误码；HTTP 状态码作兜底
    const mapped = data?.code ? SERVER_CODE_MAP[data.code] : undefined
    if (mapped) return fail(mapped)
    if (res.status === 429) return fail('RATE_LIMITED')
    if (res.status >= 500) return fail('SERVER_ERROR')
    // detail 仅用于日志/排查，不直接展示给用户（提示语一律走 i18n）
    return fail(
      'SERVER_ERROR',
      data?.error ? String(data.error).slice(0, 200) : `HTTP ${res.status}`
    )
  }

  // 下发的 license 必须过完整本地验签 + 硬盘指纹比对，防止传输链路/服务端被篡改
  const status = licenseService.loadFromString(data.license)
  if (!status.valid) {
    return fail('INVALID_LICENSE', status.error ?? undefined)
  }
  return { ok: true, status, license: data.license }
}
