// 渲染层外链协议白名单
//
// 模型输出、远端接口返回值（如 GitHub release 的 html_url）都会被拼进 href。CSP 的
// script-src 'self' 已经会拦 javascript: 导航执行，但那是兜底而非语义约束：
// 与其依赖「浏览器恰好挡住」，不如在这里就不把非 http(s) 的值当链接渲染。
const HTTP_HREF_RE = /^https?:\/\//i

/** 只接受 http(s) 绝对地址；其余返回 null（调用方降级为纯文本，不渲染可点链接） */
export function safeHttpHref(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed || !HTTP_HREF_RE.test(trimmed)) return null
  try {
    const u = new URL(trimmed)
    // 排除 javascript:/data: 被 "http://x?u=javascript:..." 之类混淆的写法：
    // 只要协议解析结果不是 http/https 就拒
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null
  } catch {
    return null
  }
}
