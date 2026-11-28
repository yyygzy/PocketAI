// SEC-16-12：导出 HTML 的两条路径（普通会话 / KB 问答）都走 safeHttpHref，
// 且导出物自带 meta CSP（脱离应用后仍是独立的安全边界）。
import { describe, it, expect } from 'vitest'
import type { MessageRecord, MessageSource, KbAskMessage } from '../src/shared/types'
import type { ExportConversationMeta, ExportKbAskSessionMeta } from '../src/shared/export-markdown'
import { buildConversationHtml, buildKbAskSessionHtml } from '../src/renderer/src/utils/export-html'

const conv: ExportConversationMeta = {
  title: '导出测试',
  modelLabel: 'test',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000
}
const session: ExportKbAskSessionMeta = {
  title: 'KB 导出测试',
  model: 'test',
  createdAt: conv.createdAt,
  updatedAt: conv.updatedAt
}

function msg(over: Partial<MessageRecord>): MessageRecord {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    content: '正文',
    provider: null,
    model: null,
    status: 'done',
    parentId: null,
    createdAt: conv.createdAt,
    ...over
  }
}

/** 一条安全 http(s) + 三种危险协议的网页来源 */
const SOURCES: MessageSource[] = [
  { chunkId: 'w0', docId: 'safe', docTitle: '安全网页', content: '', kind: 'web', url: 'https://example.com/safe?a=1' },
  { chunkId: 'w1', docId: 'js', docTitle: '危险JS', content: '', kind: 'web', url: 'javascript:alert(1)' },
  { chunkId: 'w2', docId: 'data', docTitle: '危险Data', content: '', kind: 'web', url: 'data:text/html,<script>alert(1)</script>' },
  { chunkId: 'w3', docId: 'file', docTitle: '本地文件', content: '', kind: 'web', url: 'file:///c:/windows/win.ini' },
  // 非 web 来源即便带了 url 也不当链接渲染
  { chunkId: 'k1', docId: 'kb', docTitle: '知识库来源', content: '', kind: 'kb', url: 'https://example.com/kb' }
]

function assertSourcesAndCsp(html: string): void {
  // http(s) 仍是可点外链，属性保持原口径
  expect(html).toContain('href="https://example.com/safe?a=1"')
  expect(html).toContain('rel="noreferrer"')
  expect(html).toContain('target="_blank"')
  // 危险协议一律降级纯文本：标题在、href 不在
  for (const title of ['危险JS', '危险Data', '本地文件', '知识库来源']) {
    expect(html, `${title} 应降级为纯文本`).toContain(title)
  }
  expect(html).not.toContain('href="javascript:')
  expect(html).not.toContain('href="data:')
  expect(html).not.toContain('href="file:')
  expect(html).not.toContain('href="https://example.com/kb"')
  // 独立文档的 CSP meta：无脚本/插件/表单，图片只允许内嵌（SEC-16-13）
  expect(html).toContain('http-equiv="Content-Security-Policy"')
  // react-dom/server 会把属性值里的单引号写成 &#x27;（浏览器解析时还原）
  expect(html).toContain('default-src &#x27;none&#x27;')
  expect(html).toContain('img-src data: blob:')
  expect(html).not.toContain('img-src data: blob: https:')
  expect(html).toContain('style-src &#x27;unsafe-inline&#x27;')
}

describe('SEC-16-12 — 普通会话导出 HTML', () => {
  it('两种来源均白名单化，且 head 自带 CSP meta', { timeout: 30_000 }, async () => {
    const html = await buildConversationHtml(conv, [msg({ sources: SOURCES })], '小助手')
    expect(html.startsWith('<!doctype html>')).toBe(true)
    assertSourcesAndCsp(html)
  })
})

describe('SEC-16-12/13 — KB 问答导出 HTML', () => {
  it('同样走 safeHttpHref 且 CSP 禁止远程图片', { timeout: 30_000 }, async () => {
    const messages: KbAskMessage[] = [{ role: 'assistant', content: '回答', sources: SOURCES }]
    const html = await buildKbAskSessionHtml(session, messages)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    assertSourcesAndCsp(html)
  })
})
