import React from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { MermaidBlock } from './MermaidBlock'
import { remarkCitations } from './remark-citations'

// 链接/图片协议白名单：react-markdown 默认会编码危险协议，这里再显式兜底，
// 防止依赖库行为变化放行 javascript:/vbscript:/file:/data:text/html 等。
const SAFE_NAV_HREF = /^(https?:|mailto:)/i
const SAFE_IMG_SRC = /^(https?:|data:image\/|blob:)/i

/**
 * URL 收口（react-markdown v10 的 defaultUrlTransform 只放行
 * https?|ircs?|mailto|xmpp，会清空所有 data:/blob:，导致内嵌图片无法显示）。
 * 仅补开 **data:image/** 与 blob:：二者都只进入 <img> 加载上下文，
 * 浏览器按图片解析、非图片资源加载失败，不存在脚本执行面；
 * data:text/html 等仍然清空（不能整体放行 data:）。
 */
function safeUrlTransform(value: string): string {
  if (/^data:image\//i.test(value) || /^blob:/i.test(value)) return value
  return defaultUrlTransform(value)
}

/** 从 pre > code 元素提取语言名与代码文本（react-markdown v10 结构） */
function extractCodeBlock(
  children: React.ReactNode
): { lang: string; code: string } | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!React.isValidElement(child)) return null
  const props = child.props as { className?: string; children?: React.ReactNode }
  const className = props.className ?? ''
  const m = /language-([\w-]+)/.exec(className)
  if (!m) return null
  // 代码块文本末尾通常带一个换行，渲染图表/原样显示时去掉
  const code = String(props.children ?? '').replace(/\n$/, '')
  return { lang: m[1]!.toLowerCase(), code }
}

export const Markdown: React.FC<{
  content: string
  /** 知识库来源条数：> 0 时启用正文 [n] 引用徽章解析；未传完全不拆（PopupApp/对比列等场景零行为变化） */
  citationCount?: number
  /** 引用徽章点击回调（定位到来源块对应条目）；未传时徽章仅展示不可点 */
  onCitation?: (n: number) => void
}> = ({ content, citationCount = 0, onCitation }) => {
  const plugins = citationCount > 0 ? [remarkGfm, remarkMath, remarkCitations] : [remarkGfm, remarkMath]
  return (
    <div className="markdown-body text-[14px] leading-relaxed">
      <ReactMarkdown
        urlTransform={safeUrlTransform}
        remarkPlugins={plugins}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          sup: ({ node, children, ...props }) => {
            // 知识库引用徽章（remarkCitations 产出）：hProperties['data-citation'] → properties.dataCitation
            const dataProps = (node as unknown as { properties?: Record<string, unknown> }).properties
            const raw = dataProps?.dataCitation
            const n = typeof raw === 'string' || typeof raw === 'number' ? Number(raw) : NaN
            if (!Number.isFinite(n)) return <sup {...props}>{children}</sup>
            const inRange = n >= 1 && n <= citationCount
            const cls = inRange
              ? 'kb-citation inline-flex items-center align-super mx-0.5 px-1 rounded border border-[var(--color-border)] text-[10px] leading-[1.4] text-[var(--color-accent)] hover:bg-[var(--color-accent-soft)] transition-colors'
              : 'kb-citation inline-flex items-center align-super mx-0.5 px-1 rounded border border-[var(--color-border)] text-[10px] leading-[1.4] text-[var(--color-text-muted)]'
            if (inRange && onCitation) {
              return (
                <button type="button" className={`${cls} cursor-pointer`} onClick={() => onCitation(n)}>
                  [{n}]
                </button>
              )
            }
            return <span className={cls}>[{n}]</span>
          },
          a: ({ node, href, children, ...props }) => {
            // 非白名单协议：渲染为无 href 的纯文本样式锚点，不可点击
            if (!href || !SAFE_NAV_HREF.test(href)) {
              return <a {...props} className="text-[var(--color-accent)] underline">{children}</a>
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline">
                {children}
              </a>
            )
          },
          img: ({ node, src, alt, ...props }) => {
            if (!src || !SAFE_IMG_SRC.test(src)) return null
            return <img {...props} src={src} alt={alt ?? ''} className="max-w-full rounded-lg my-2" />
          },
          pre: ({ children }) => {
            // 在解析结构层（而非渲染后 HTML 正则）拦截 mermaid 代码块 → SVG 图表
            const block = extractCodeBlock(children)
            if (block?.lang === 'mermaid') {
              return <MermaidBlock code={block.code} />
            }
            return (
              <pre className="rounded-lg p-3 overflow-x-auto text-[13px] my-2 bg-[var(--hljs-bg)] text-[var(--hljs-text)]">{children}</pre>
            )
          },
          code: ({ className, children, ...props }) => (
            <code className={`${className ?? ''} font-mono`} {...props}>
              {children}
            </code>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2">
              <table className="border-collapse text-[13px]">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-[var(--color-border)] px-2 py-1 bg-[var(--color-hover-overlay)]">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-[var(--color-border)] px-2 py-1">{children}</td>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
