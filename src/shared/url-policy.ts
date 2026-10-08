// 出网目标的协议口径（Provider baseUrl / 本地推理服务共用）
//
// 缺协议时补 https 而非 http：补错方向会让 Bearer Key 与全部上下文明文上网。
// 回环 http 是 Ollama / LM Studio 等本地服务的既有惯例，放行。
// 主机名口径与 schemas/mcp.ts 的 pip 源例外一致（同一组回环地址）。

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/** 取小写主机名（IPv6 带方括号）；无法解析返回 null */
export function urlHost(raw: string): string | null {
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return null
  }
}

export function isLoopbackHost(host: string | null): boolean {
  return !!host && LOOPBACK_HOSTS.has(host)
}

/** 无协议头 → 按回环例外补 scheme；已带协议原样返回 */
export function ensureScheme(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return raw
  return `${isLoopbackHost(urlHost(raw)) ? 'http' : 'https'}://${raw}`
}

/** 风险态：显式 http:// 且目标不是回环（将以明文携带 API Key） */
export function isPlainRemoteHttp(raw: string): boolean {
  if (!/^http:\/\//i.test(raw)) return false
  return !isLoopbackHost(urlHost(raw))
}
