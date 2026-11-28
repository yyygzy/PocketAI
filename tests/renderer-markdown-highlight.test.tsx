// PERF-02：rehype-highlight 配置 —— detect:false + 语言子集
//
// 回归要点：
//  · detect:false 下，无语言标注的围栏块不再触发 highlightAuto（37 语言嗅探，实测慢 18 倍），
//    直接降级为纯文本展示（不报错）；
//  · 有语言标注的块仍正常高亮（language-ts + hljs token class）；
//  · 未注册的未知语言降级为警告（v7 已移除 ignoreMissing 选项），不抛错。
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { Markdown } from '../src/renderer/src/modules/chat/Markdown'

/** 渲染为静态 HTML 字符串（node 环境，与 markdown-render.test.ts 同构） */
function md(source: string): string {
  return renderToString(React.createElement(Markdown, { content: source }))
}

describe('PERF-02 — detect:false 生效', () => {
  it('无语言标注块：不触发高亮（无 token 着色），纯文本展示且不抛错', () => {
    const html = md('```\nconst a = 1\n```')
    expect(html).toContain('const a = 1')
    // detect:true 时 highlightAuto 会产出 language-xxx 与 hljs-xxx token span；
    // detect:false 直接跳过（不判 CSS 变量名 --hljs-bg，那只是主题色类）
    expect(html).not.toContain('<span class="hljs-')
    expect(html).not.toContain('language-')
  })

  it('有语言标注块（ts）：正常高亮（language-ts + hljs token class）', () => {
    const html = md('```ts\nconst a = 1\n```')
    expect(html).toContain('language-ts')
    expect(html).toContain('hljs-keyword')
  })

  it('未注册的未知语言（foobar）：降级为纯文本，不抛错', () => {
    const html = md('```foobar\njust some text\n```')
    expect(html).toContain('just some text')
    // 无 token 着色（hljs-v7 对未注册语言只留警告）
    expect(html).not.toContain('<span class="hljs-')
  })

  it('子集语言（sql）：仍在白名单内，正常高亮', () => {
    const html = md('```sql\nSELECT * FROM t\n```')
    expect(html).toContain('language-sql')
    expect(html).toMatch(/hljs-\w/)
  })
})
