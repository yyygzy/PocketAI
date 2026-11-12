// 沙箱 HTML 的 CSP 注入：统一给「迷你应用预览」和「多文件项目 index.html」用，
// 避免两处各写一份 CSP、慢慢漂移。
//
// 口径：
//  · default-src 'none'：禁外连、禁外部脚本；
//  · script/style 只允许内联，img 只允许 data:/blob:；
//  · 注入前剥离 meta-refresh——iframe 自导航后的新文档不继承 meta CSP（残余风险，见 review Minor-1）。
export const PREVIEW_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:"

/** DOMParser 结构化解析后插到真实 <head> 首位，杜绝正则定位被注释/属性/字符串规避 */
export function injectCsp(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  doc.querySelectorAll('meta[http-equiv]').forEach((m) => {
    const he = (m.getAttribute('http-equiv') || '').trim().toLowerCase()
    if (he === 'refresh') m.remove()
  })
  const meta = doc.createElement('meta')
  meta.setAttribute('http-equiv', 'Content-Security-Policy')
  meta.setAttribute('content', PREVIEW_CSP)
  doc.head.insertBefore(meta, doc.head.firstChild)
  return '<!DOCTYPE html>' + doc.documentElement.outerHTML
}
