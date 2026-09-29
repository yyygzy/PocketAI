// remark-citations 插件测试：[n] 引用标记拆分（纯函数 + mdast 树两层验证）
import { describe, it, expect } from 'vitest'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { remarkCitations, splitCitationText } from '../src/renderer/src/modules/chat/remark-citations'
import type { Root, RootContent } from 'mdast'

/** 解析 + 跑插件后收集节点序列（段落子节点） */
function parsePara(md: string): Array<Record<string, unknown>> {
  const tree = fromMarkdown(md) as Root
  remarkCitations()(tree)
  const para = tree.children[0] as unknown as { children: Array<Record<string, unknown>> }
  return para.children
}

function textNodes(md: string): string[] {
  const tree = fromMarkdown(md) as Root
  remarkCitations()(tree)
  const out: string[] = []
  const walk = (n: RootContent) => {
    if (n.type === 'text') out.push((n as unknown as { value: string }).value)
    const kids = (n as unknown as { children?: RootContent[] }).children
    if (kids) kids.forEach(walk)
  }
  tree.children.forEach(walk)
  return out
}

describe('splitCitationText — 文本层拆分', () => {
  it('无引用标记返回 null（原样保留）', () => {
    expect(splitCitationText('普通句子')).toBeNull()
    expect(splitCitationText('[abc] [1a] []')).toBeNull()
  })

  it('单个 [1] 拆为 text + citation + text', () => {
    const parts = splitCitationText('根据资料 [1] 所述')!
    expect(parts).toHaveLength(3)
    expect(parts[0]).toEqual({ type: 'text', value: '根据资料 ' })
    const cit = parts[1] as { type: string; data: { hName: string; hProperties: Record<string, unknown> } }
    expect(cit.type).toBe('emphasis')
    expect(cit.data.hName).toBe('sup')
    expect(cit.data.hProperties['data-citation']).toBe('1')
    expect(parts[2]).toEqual({ type: 'text', value: ' 所述' })
  })

  it('开头/结尾/连续标记均正确切分', () => {
    expect(splitCitationText('[1]开头')).toHaveLength(2)
    expect(splitCitationText('结尾[2]')).toHaveLength(2)
    const two = splitCitationText('[1][2]')!
    expect(two).toHaveLength(2)
    expect((two[0] as { data: { hProperties: Record<string, unknown> } }).data.hProperties['data-citation']).toBe('1')
    expect((two[1] as { data: { hProperties: Record<string, unknown> } }).data.hProperties['data-citation']).toBe('2')
  })

  it('两位编号可匹配，三位不匹配', () => {
    expect(splitCitationText('[12]')![0]!.type).toBe('emphasis')
    expect(splitCitationText('[123]')).toBeNull()
  })
})

describe('remarkCitations — mdast 树变换', () => {
  it('正文 [1] 被替换为带 data-citation 的节点', () => {
    const para = parsePara('根据资料 [1] 所述')
    expect(para).toHaveLength(3)
    expect(para[1]!.type).toBe('emphasis')
  })

  it('代码块与行内代码内的 [1] 不拆', () => {
    // 行内代码：值不属于 text 节点
    expect(textNodes('行内 `code[1]` 保持')).toEqual(['行内 ', ' 保持'])
    // 围栏代码块整块不拆
    const tree = fromMarkdown('```\nfn[1]\n```') as Root
    remarkCitations()(tree)
    expect(JSON.stringify(tree)).toContain('fn[1]')
  })

  it('链接文字 [1](url) 不误拆（方括号属于 link 语法）', () => {
    const tree = fromMarkdown('[1](https://example.com)') as Root
    remarkCitations()(tree)
    const para = tree.children[0] as unknown as { children: Array<{ type: string }> }
    expect(para.children[0]!.type).toBe('link')
  })

  it('多段落与列表内的 [n] 均被拆分', () => {
    const tree = fromMarkdown('甲[1]\n\n- 乙[2]') as Root
    remarkCitations()(tree)
    const json = JSON.stringify(tree)
    expect(json).toContain('"data-citation":"1"')
    expect(json).toContain('"data-citation":"2"')
  })
})
