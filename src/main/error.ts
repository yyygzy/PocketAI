// 主进程 catch 异常收口（中性模块，services 层不应依赖 ipc/safe-handle）。
// errMsg：unknown 异常 → 可展示文本，禁止再用 (e as Error).message 不安全断言
//   （throw 字符串/非 Error 值时断言取到 undefined，错误信息直达用户或日志丢失）。
// isAbortError：AbortController 中止在 Node 与 fetch（undici）里抛出的错误
//   名字可能是 AbortError / TimeoutError / DOMException，统一判定。
/** unknown 异常 → 可展示的错误文本：Error 取 message，原始字符串直接用，其余走 fallback */
export function errMsg(e: unknown, fallback = '未知错误'): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}

/** 是否为主动中止（AbortSignal.abort / 超时 abort）抛出的错误 */
export function isAbortError(e: unknown): boolean {
  if (e instanceof DOMException) return e.name === 'AbortError'
  return e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError')
}
