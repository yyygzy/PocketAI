// Anthropic / Gemini 原生适配器共用的流控制与 SSE 解析。
// 只放协议无关部分：真正的 fetch 留在各适配器里，便于出网清单按文件登记。
import { ProviderError, type ChatParams } from './types'

export const NO_REDIRECT: RequestInit = { redirect: 'manual' }

const FIRST_BYTE_TIMEOUT_MS = 90_000
const STREAM_IDLE_TIMEOUT_MS = 60_000
const REQUEST_TOTAL_TIMEOUT_MS = 180_000

export function assertNoRedirect(res: Response): void {
  if (res.status >= 300 && res.status < 400) {
    throw new ProviderError(
      '服务端返回了重定向，已拒绝跟随（防止 API Key 被发送到重定向目标主机）；请检查 Base URL 是否正确',
      res.status
    )
  }
}

/** `Retry-After` 只接受秒数或 HTTP 日期；解析不出返回 undefined */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  const raw = String(header ?? '').trim()
  if (!raw) return undefined
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.floor(asNumber * 1000)
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  return Math.max(0, at - now)
}

export interface StreamTimers {
  signal: AbortSignal
  armActivity(): void
  cleanup(): void
  /** 内部超时返回可重试错误；用户主动取消或正常结束返回 null */
  timeoutError(): ProviderError | null
}

/**
 * 外部取消 + 首字节 / 流空闲 / 总时长三档超时合并到同一个 controller。
 * 与 OpenAI 兼容适配器同口径：用户主动取消原样抛，内部超时转可重试 ProviderError。
 */
export function createStreamTimers(params: ChatParams): StreamTimers {
  const ac = new AbortController()
  let phase: 'first-byte' | 'idle' | 'total' | null = null
  const onExternalAbort = (): void => ac.abort()
  const external = params.signal
  if (external) {
    if (external.aborted) ac.abort()
    else external.addEventListener('abort', onExternalAbort)
  }
  let firstByteTimer: ReturnType<typeof setTimeout> | undefined
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const totalTimer = setTimeout(() => {
    phase ??= 'total'
    ac.abort()
  }, REQUEST_TOTAL_TIMEOUT_MS)
  const armFirstByte = (): void => {
    clearTimeout(firstByteTimer)
    firstByteTimer = setTimeout(() => {
      phase ??= 'first-byte'
      ac.abort()
    }, FIRST_BYTE_TIMEOUT_MS)
  }
  const armActivity = (): void => {
    clearTimeout(firstByteTimer)
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      phase ??= 'idle'
      ac.abort()
    }, STREAM_IDLE_TIMEOUT_MS)
  }
  armFirstByte()
  return {
    signal: ac.signal,
    armActivity,
    cleanup() {
      clearTimeout(firstByteTimer)
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      external?.removeEventListener('abort', onExternalAbort)
    },
    timeoutError() {
      if (phase === 'first-byte') {
        return new ProviderError(`请求超时：${FIRST_BYTE_TIMEOUT_MS / 1000}s 内未收到响应（${params.model}）`, undefined, true)
      }
      if (phase === 'idle') {
        return new ProviderError(`流式响应空闲超时：${STREAM_IDLE_TIMEOUT_MS / 1000}s 无新数据（${params.model}）`, undefined, true)
      }
      if (phase === 'total') {
        return new ProviderError(`请求总时长超过 ${REQUEST_TOTAL_TIMEOUT_MS / 1000}s（${params.model}）`, undefined, true)
      }
      return null
    }
  }
}

/**
 * 逐条 SSE `data:` 事件回调。回调返回 true 时提前结束流（例如收到 message_stop）。
 * reader.cancel 的失败一律吞掉：流已经被中止，失败无关紧要。
 */
export async function readSSE(
  res: Response,
  onEvent: (data: string) => boolean | void,
  signal?: AbortSignal,
  onActivity?: () => void
): Promise<void> {
  if (!res.body) throw new ProviderError('响应体为空')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const onAbort = (): void => { reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', onAbort)
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      onActivity?.()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        if (onEvent(data) === true) return
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}
