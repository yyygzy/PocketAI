// remark 插件：把正文文本中的 [1]、[2] 引用标记拆成引用节点，
// 经 mdast-util-to-hast 的 data.hName/hProperties 渲染为 <sup data-citation="n">，
// 由 Markdown.tsx 的 sup 组件映射成可点击徽章（点击定位到消息来源块）。
// 只处理 phrasing 层的 text 节点：代码块/行内代码的值不是 text 节点，天然不误拆。
import type { Root, Text } from 'mdast'
import { visit, SKIP } from 'unist-util-visit'

/** 匹配 1~2 位编号的引用标记，避免把 [1000] 这类数组下标说明误拆 */
const CITATION_RE = /\[(\d{1,2})\]/g

/** 拆分产物：mdast text 节点或 citation emphasis 节点 */
export type CitationPart =
  | { type: 'text'; value: string }
  | {
      type: 'emphasis'
      data: { hName: 'sup'; hProperties: { className: string[]; 'data-citation': string } }
      children: Array<{ type: 'text'; value: string }>
    }

/** 把一段 text 值按引用标记切分为 [text | citation] 交替序列；无匹配返回 null */
export function splitCitationText(value: string): CitationPart[] | null {
  CITATION_RE.lastIndex = 0
  if (!CITATION_RE.test(value)) return null

  const parts: CitationPart[] = []
  let last = 0
  let m: RegExpExecArray | null
  CITATION_RE.lastIndex = 0
  while ((m = CITATION_RE.exec(value))) {
    if (m.index > last) parts.push({ type: 'text', value: value.slice(last, m.index) })
    parts.push({
      type: 'emphasis',
      data: {
        hName: 'sup',
        hProperties: { className: ['kb-citation'], 'data-citation': m[1]! }
      },
      children: [{ type: 'text', value: `[${m[1]}]` }]
    })
    last = m.index + m[0].length
  }
  if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
  return parts
}

/**
 * 收集正文里真正会渲染成引用徽章的编号（去重、升序）。
 * 与插件口径一致：代码块/行内代码不是 text 节点，链接与图片的方括号也不算引用。
 * 仅用于展示「引用覆盖率」，不参与渲染。
 */
export function collectCitationRefs(markdown: string): number[] {
  const withoutCode = markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '')
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, '')
  const seen = new Set<number>()
  const re = new RegExp(CITATION_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(withoutCode))) seen.add(Number(m[1]))
  return [...seen].sort((a, b) => a - b)
}

export function remarkCitations() {
  return (tree: Root): void => {
    visit(tree, 'text', (node, index, parent) => {
      const value = String((node as Text).value ?? '')
      if (!parent || index === undefined) return
      const parts = splitCitationText(value)
      if (!parts) return
      parent.children.splice(index, 1, ...(parts as unknown as Root['children']))
      // text 是叶子节点：SKIP 跳过子遍历，index 跳到插入段之后继续扫描
      return [SKIP, index + parts.length] as const
    })
  }
}
