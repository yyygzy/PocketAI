// 围栏代码块解析纯函数：从 react-markdown 产出的 <code> 元素 props
// 提取语言标识与代码文本。无渲染/剪贴板/react 运行时依赖，便于单测。
import type { ReactNode } from 'react'

export interface ParsedCodeBlock {
  /** 语言标识（小写）；无语言围栏（```）为 null */
  lang: string | null
  /** 代码文本；围栏代码末尾通常带一个换行，仅去掉这一个 */
  code: string
}

/**
 * 把 react-markdown 的 children 递归拍平为纯文本。
 * rehype-highlight 会把代码拆成 <span> token 元素，不能直接 String(children)
 * （会得到 [object Object]）；高亮只包裹不改写文本，递归拼接即得到原始代码。
 * 用鸭子类型识别 React 元素（{ props: { children } }），避免引入 react 运行时。
 */
export function nodesToText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodesToText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return nodesToText((node as { props?: { children?: unknown } }).props?.children)
  }
  return ''
}

/**
 * 解析 react-markdown v10 的 inline code / fenced code 元素 props。
 * 调用方需自行确认它是 pre 内的围栏块（inline code 不应有复制按钮）。
 */
export function parseCodeProps(props: { className?: string; children?: ReactNode }): ParsedCodeBlock {
  const m = /language-([\w-]+)/.exec(props.className ?? '')
  const code = nodesToText(props.children).replace(/\n$/, '')
  return { lang: m ? m[1]!.toLowerCase() : null, code }
}

/** 代码块超过此行数默认折叠（长日志/长源码不再刷屏） */
export const CODE_COLLAPSE_THRESHOLD = 20
/** 折叠态露出的预览行数（CSS max-height 按 12 行 × 20px = 240px 裁切） */
export const CODE_PREVIEW_LINES = 12

/** 统计代码行数：按换行切分；空串计 0 行 */
export function countCodeLines(code: string): number {
  if (code === '') return 0
  return code.split('\n').length
}

/** 是否应默认折叠：行数严格大于阈值 */
export function isCollapsible(code: string, threshold: number = CODE_COLLAPSE_THRESHOLD): boolean {
  return countCodeLines(code) > threshold
}

/** 取前 n 行用于预览（纯函数；UI 实际用 CSS 裁切，此函数主要供测试/语义复用） */
export function previewLines(code: string, n: number): string {
  if (n <= 0) return ''
  return code.split('\n').slice(0, n).join('\n')
}
