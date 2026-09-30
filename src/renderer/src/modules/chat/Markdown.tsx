import React, { useEffect, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import { MermaidBlock } from './MermaidBlock'
import { remarkCitations } from './remark-citations'
import { useI18n } from '../../i18n'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { parseCodeProps, type ParsedCodeBlock } from '../../utils/code-block'

// katex 懒加载（主包瘦身 ~280KB）：rehype-katex + katex.min.css 均为动态 import，
// 模块图不再静态包含。ready 前公式以原始 LaTeX 文本渲染，ready 后重渲染为公式；
// CSS 与插件同批加载，不会出现无样式的公式中间态。
let katexPromise: Promise<void> | null = null
let katexPlugin: PluggableList[number] | null = null
function ensureKatex(): Promise<void> {
  katexPromise ??= Promise.all([
    import('rehype-katex').then((m) => {
      katexPlugin = m.default
    }),
    import('katex/dist/katex.min.css')
  ]).then(() => undefined)
  return katexPromise
}

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
): ParsedCodeBlock | null {
  const child = Array.isArray(children) ? children[0] : children
  if (!React.isValidElement(child)) return null
  const props = child.props as { className?: string; children?: React.ReactNode }
  return parseCodeProps(props)
}

const PRE_CLASS =
  'rounded-lg p-3 overflow-x-auto text-[13px] bg-[var(--hljs-bg)] text-[var(--hljs-text)]'

/** 围栏代码块：右上角「复制」按钮（含已复制反馈），按钮定位于包裹层，不随横向滚动移位 */
const CodeBlock: React.FC<{ block: ParsedCodeBlock; children: React.ReactNode }> = ({ block, children }) => {
  const { t } = useI18n()
  const { copied, copy } = useCopyFeedback()
  const label = copied ? t('common.copied') : t('common.copy')
  return (
    <div className="relative group my-2">
      <pre className={`${PRE_CLASS} m-0`}>{children}</pre>
      <button
        type="button"
        onClick={() => void copy(block.code)}
        title={block.lang ? `${block.lang} · ${label}` : label}
        aria-label={label}
        className="absolute top-1.5 right-1.5 flex items-center gap-1 rounded border border-[var(--color-border)] bg-[var(--color-sidebar)] px-1.5 py-0.5 text-[10px] leading-4 text-[var(--color-text-muted)] opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M3 8.5 6.5 12 13 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <rect x="5" y="5" width="8.5" height="8.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M3 10.5H2.5A1.5 1.5 0 0 1 1 9V2.5A1.5 1.5 0 0 1 2.5 1H9a1.5 1.5 0 0 1 1.5 1.5V3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        )}
        <span>{label}</span>
      </button>
    </div>
  )
}

export const Markdown: React.FC<{
  content: string
  /** 知识库来源条数：> 0 时启用正文 [n] 引用徽章解析；未传完全不拆（PopupApp/对比列等场景零行为变化） */
  citationCount?: number
  /** 引用徽章点击回调（定位到来源块对应条目）；未传时徽章仅展示不可点 */
  onCitation?: (n: number) => void
  /** 围栏代码块是否显示「复制」按钮；静态导出 HTML（无事件处理器）传 false */
  codeCopy?: boolean
}> = ({ content, citationCount = 0, onCitation, codeCopy = true }) => {
  // katex 就绪后一次性重渲染所有 Markdown 实例（模块级单例，全局仅一次）
  const [katexReady, setKatexReady] = useState(Boolean(katexPlugin))
  useEffect(() => {
    if (katexReady) return
    let alive = true
    void ensureKatex().then(() => {
      if (alive) setKatexReady(true)
    })
    return () => {
      alive = false
    }
  }, [katexReady])

  const plugins = citationCount > 0 ? [remarkGfm, remarkMath, remarkCitations] : [remarkGfm, remarkMath]
  const rehypePlugins: PluggableList = katexPlugin
    ? [katexPlugin, [rehypeHighlight, { detect: true, ignoreMissing: true }]]
    : [[rehypeHighlight, { detect: true, ignoreMissing: true }]]
  return (
    <div className="markdown-body text-[14px] leading-relaxed">
      <ReactMarkdown
        urlTransform={safeUrlTransform}
        remarkPlugins={plugins}
        rehypePlugins={rehypePlugins}
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
            if (!codeCopy || !block) {
              return (
                <pre className={`${PRE_CLASS} my-2`}>{children}</pre>
              )
            }
            return <CodeBlock block={block}>{children}</CodeBlock>
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
