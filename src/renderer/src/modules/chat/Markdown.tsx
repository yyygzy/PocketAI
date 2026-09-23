import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { MermaidBlock } from './MermaidBlock'

// 链接/图片协议白名单：react-markdown 默认会编码危险协议，这里再显式兜底，
// 防止依赖库行为变化放行 javascript:/vbscript:/file:/data:text/html 等。
const SAFE_NAV_HREF = /^(https?:|mailto:)/i
const SAFE_IMG_SRC = /^(https?:|data:image\/|blob:)/i

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

export const Markdown: React.FC<{ content: string }> = ({ content }) => {
  return (
    <div className="markdown-body text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, [rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node, href, children, ...props }) => {
            // 非白名单协议：渲染为无 href 的纯文本样式锚点，不可点击
            if (!href || !SAFE_NAV_HREF.test(href)) {
              return <a {...props} className="text-[var(--color-accent)] underline">{children}</a>
            }
            return (
              <a {...props} href={href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline" />
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
