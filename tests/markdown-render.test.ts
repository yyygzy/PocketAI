// Markdown 渲染测试（node 环境 + react-dom/server，无需 jsdom）
//
// 重点回归：白名单链接必须渲染链接文本（曾因 <a .../> 自闭合缺 children，
// 所有 http(s) 链接显示为空）；同时验证协议白名单收口仍生效。
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Markdown } from '../src/renderer/src/modules/chat/Markdown'

/** 渲染为静态 HTML 字符串 */
function md(source: string): string {
  return renderToString(React.createElement(Markdown, { content: source }))
}

describe('Markdown — 链接渲染', () => {
  it('http 链接：文本可见 + href/target/rel 正确（回归 children 丢失）', () => {
    const html = md('[打开官网](https://example.com)')
    expect(html).toContain('打开官网')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
  })

  it('mailto 链接：文本可见且可点', () => {
    const html = md('[联系我](mailto:a@b.com)')
    expect(html).toContain('联系我')
    expect(html).toContain('href="mailto:a@b.com"')
  })

  it('javascript: 协议：文本显示但无 href（不可点）', () => {
    const html = md('[x](javascript:alert(1))')
    expect(html).toContain('>x</a>')
    expect(html).not.toContain('href="javascript:')
  })

  it('file: 与 vbscript: 协议同样剥离 href', () => {
    const f = md('[f](file:///c:/windows/win.ini)')
    expect(f).not.toContain('href="file:')
    const v = md('[v](vbscript:msgbox(1))')
    expect(v).not.toContain('href="vbscript:')
  })
})

describe('Markdown — 图片协议收口', () => {
  // 标准 1x1 gif（短且确定有效）
  const GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

  it('data:image 图片正常渲染（v10 默认 urlTransform 会清空 data:，需自定义补开）', () => {
    const html = md(`![图](${GIF})`)
    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/')
    expect(html).toContain('alt="图"')
  })

  it('https 图片正常渲染', () => {
    const html = md('![x](https://example.com/a.png)')
    expect(html).toContain('src="https://example.com/a.png"')
  })

  it('data:text/html 不渲染（只补开 data:image，防 HTML 注入面）', () => {
    const html = md('![x](data:text/html,<script>alert(1)</script>)')
    expect(html).not.toContain('data:text/html')
    expect(html).not.toContain('<img')
  })

  it('blob: URL 放行（仅进入 img 加载上下文）', () => {
    const url = 'blob:https://example.com/550e8400-e29b-41d4-a716-446655440000'
    const html = md(`![b](${url})`)
    expect(html).toContain(`src="${url}"`)
  })
})

describe('Markdown — raw HTML 默认不渲染（react-markdown 无 rehype-raw）', () => {
  it('内联 HTML 标签被转义为文本，不产出真实元素/属性', () => {
    const html = md('before <img src=x onerror=alert(1)> after')
    // 转义文本形态安全：浏览器只显示文字
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    // 不允许未转义的标签（那才会成为真实属性）
    expect(html).not.toContain('<img src=x onerror=alert(1)>')
  })
})
