// 对话导出构建器测试：Markdown 保真/来源/附件/用量/文件名去重 + HTML 结构与 XSS 过滤
import { describe, it, expect } from 'vitest'
import type { MessageRecord } from '../src/shared/types'
import {
  buildConversationMarkdown,
  formatSources,
  formatAttachments,
  safeFileName,
  dedupeFileNames
} from '../src/shared/export-markdown'

const conv = {
  title: '测试会话',
  modelLabel: 'gpt-test',
  createdAt: new Date('2026-09-01T10:00:00').getTime(),
  updatedAt: new Date('2026-09-01T10:05:00').getTime()
}

function msg(over: Partial<MessageRecord>): MessageRecord {
  return {
    id: over.id ?? 'm1',
    conversationId: 'c1',
    role: over.role ?? 'user',
    content: over.content ?? '',
    provider: null,
    model: null,
    status: 'done',
    parentId: null,
    createdAt: over.createdAt ?? conv.createdAt,
    ...over
  }
}

describe('buildConversationMarkdown', () => {
  it('assistant 正文保真：标题/列表/代码块原样输出，不再整体包代码块', () => {
    const body = '## 小标题\n\n- 项目一\n- 项目二\n\n```js\nconst x = 1\n```'
    const md = buildConversationMarkdown(conv, [msg({ role: 'assistant', content: body })])
    expect(md).toContain('## 小标题')
    expect(md).toContain('- 项目一')
    expect(md).toContain('```js')
    expect(md).toContain('const x = 1')
    // 旧实现用 ~~~ fence 包裹全文；保真后不应出现该兜底围栏
    expect(md).not.toContain('~~~')
  })

  it('user 正文以引用块逐行包裹，内含标题不产生结构跳级', () => {
    const md = buildConversationMarkdown(conv, [msg({ role: 'user', content: '## 伪造标题\n普通内容' })])
    expect(md).toContain('> ## 伪造标题')
    expect(md).toContain('> 普通内容')
    // 行首（非引用）不应出现用户注入的二级标题
    const headingAtLineStart = md.split('\n').some((l) => l.startsWith('## 伪造标题'))
    expect(headingAtLineStart).toBe(false)
  })

  it('头部含元信息与助手名', () => {
    const md = buildConversationMarkdown(conv, [msg({})], '小助手')
    expect(md).toContain('# 测试会话')
    expect(md).toContain('`gpt-test`')
    expect(md).toContain('**助手**：小助手')
    expect(md).toContain('**消息数**：1')
  })
})

describe('formatSources', () => {
  it('按 docTitle 去重并带序号', () => {
    const lines = formatSources([
      { chunkId: '1', docId: 'd1', docTitle: '文档A', content: 'x' },
      { chunkId: '2', docId: 'd1', docTitle: '文档A', content: 'y' },
      { chunkId: '3', docId: 'd2', docTitle: '文档B', content: 'z' }
    ])
    expect(lines).toEqual(['[1] 文档A', '[2] 文档B'])
    // 空标题兜底
    expect(formatSources([{ chunkId: '9', docId: 'd', docTitle: '', content: '' }])[0]).toBe('[1] (未命名文档)')
    expect(formatSources(null)).toEqual([])
  })

  it('builder 在 assistant 消息后输出参考来源块', () => {
    const md = buildConversationMarkdown(conv, [msg({
      role: 'assistant',
      content: '结论',
      sources: [{ chunkId: '1', docId: 'd1', docTitle: '手册', content: '片段' }]
    })])
    expect(md).toContain('**参考来源：**')
    expect(md).toContain('- [1] 手册')
    // 来源片段正文不进导出（降噪）
    expect(md).not.toContain('片段')
  })
})

describe('formatAttachments', () => {
  it('图片附件只列名，不泄漏 base64', () => {
    const lines = formatAttachments([{
      type: 'image', name: 'a.png', mimeType: 'image/png', size: 10,
      data: 'data:image/png;base64,' + 'x'.repeat(1000)
    }])
    const joined = lines.join('\n')
    expect(joined).toContain('📎 图片：a.png')
    expect(joined).not.toContain('base64')
  })

  it('文本附件附预览并在超长时截断', () => {
    const long = '字'.repeat(2100)
    const lines = formatAttachments([{ type: 'text', name: 'note.txt', mimeType: 'text/plain', size: 2100, data: long }])
    expect(lines[0]).toContain('📎 文本附件：note.txt')
    expect(lines.some((l) => l.includes('…（截断）'))).toBe(true)
    // 截断后不包含全文末尾
    expect(lines.join('\n')).not.toContain(long)
  })
})

describe('usage / 文件名工具', () => {
  it('usage 行输出三项 token 数', () => {
    const md = buildConversationMarkdown(conv, [msg({
      role: 'assistant',
      content: 'ok',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 }
    })])
    expect(md).toContain('输入 10 / 输出 20 / 合计 30')
  })

  it('safeFileName 替换 Windows 非法字符并兜底', () => {
    expect(safeFileName('a/b:c*d?e')).toBe('a_b_c_d_e')
    expect(safeFileName('///')).toBe('conversation')
  })

  it('dedupeFileNames 同名追加序号且保持顺序', () => {
    expect(dedupeFileNames(['a.md', 'b.md', 'a.md', 'a.md'])).toEqual(['a.md', 'b.md', 'a-2.md', 'a-3.md'])
    // 无扩展名也工作
    expect(dedupeFileNames(['x', 'x'])).toEqual(['x', 'x-2'])
    expect(dedupeFileNames([])).toEqual([])
  })
})

describe('buildConversationHtml', () => {
  it('输出自包含文档结构并过滤消息中的脚本注入', async () => {
    // 动态导入：该模块依赖 react-dom/server 与 Markdown 渲染管线
    const { buildConversationHtml } = await import('../src/renderer/src/utils/export-html')
    const html = await buildConversationHtml(conv, [
      msg({ id: 'u1', role: 'user', content: '正常问题 <script>alert(1)</script> 结尾' }),
      msg({
        id: 'a1',
        role: 'assistant',
        content: '## 回答\n\n正文',
        sources: [{ chunkId: '1', docId: 'd1', docTitle: '手册', content: '' }]
      })
    ], '小助手')

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<title>测试会话</title>')
    expect(html).toContain('小助手')
    expect(html).toContain('手册')
    expect(html).toContain('回答')
    // 关键安全断言：消息正文里的裸 <script> 不得作为标签存活
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('alert(1)</script>')
  })
})
