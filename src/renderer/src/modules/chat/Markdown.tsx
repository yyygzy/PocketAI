import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import type { Components } from 'react-markdown'
import type { PluggableList } from 'unified'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import { MermaidBlock } from './MermaidBlock'
import { remarkCitations } from './remark-citations'
import { useI18n } from '../../i18n'
import { useCopyFeedback } from '../../hooks/useCopyFeedback'
import { parseCodeProps, countCodeLines, isCollapsible, CODE_PREVIEW_LINES, type ParsedCodeBlock } from '../../utils/code-block'
import { codeCollapseLines, subscribeCodeCollapse } from '../../code-collapse'
import { safeHttpHref } from '../../utils/external-url'

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
// SEC-16-13：离线优先产品，图片只认内嵌 data:image/ 与 blob:。远程 http(s) 源
// 在渲染阶段硬拦（不发任何跨域请求，开发模式同样成立），降级为文本/链接占位。
const SAFE_IMG_SRC = /^(data:image\/|blob:)/i

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

// PERF-03：不依赖运行时状态的 plugins / components 全部提升为模块级常量。
// react-markdown 的 options 引用一变就全量重解析并卸载重挂整棵子树（CodeBlock 的
// 折叠态被重置、MermaidBlock 反复 mermaid.render），每次渲染新建字面量不可接受。
const PRE_PLAIN: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
  <pre className={`${PRE_CLASS} my-2`}>{children}</pre>
)

/** 围栏代码块 pre（codeCopy=true）：mermaid 代码块拦给 MermaidBlock，其余走 CodeBlock（复制按钮 + 折叠）；
 *  解析结构里拿不到代码块（如 pre 直接裹裸文本）时退回纯 pre */
const PRE_WITH_COPY: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const block = extractCodeBlock(children)
  if (block?.lang === 'mermaid') {
    return <MermaidBlock code={block.code} />
  }
  if (!block) return <PRE_PLAIN>{children}</PRE_PLAIN>
  return <CodeBlock block={block}>{children}</CodeBlock>
}

const BASE_COMPONENTS: Components = {
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
    if (!src || !SAFE_IMG_SRC.test(src)) {
      // SEC-16-13：外域/危险协议都不产出 <img>，渲染阶段即无跨域请求。
      // 仅 http(s) 源给一个可点链接（用户主动点击才导航），其余降级为纯文本；
      // 文案不硬编码：链接文字就是模型给的 alt（未给时用中性占位符）。
      const label = alt || '[image]'
      const href = safeHttpHref(src)
      return href ? (
        <a href={href} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline">
          {label}
        </a>
      ) : (
        <span className="text-[var(--color-text-muted)]">{label}</span>
      )
    }
    // 内嵌图片：no-referrer + lazy 兜底（CSP img-src 同样只放行 data:/blob:）
    return (
      <img
        {...props}
        src={src}
        alt={alt ?? ''}
        referrerPolicy="no-referrer"
        loading="lazy"
        className="max-w-full rounded-lg my-2"
      />
    )
  },
  pre: PRE_WITH_COPY,
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
}

/** 静态导出（codeCopy=false）：不挂 CodeBlock，纯 pre 展示 */
const BASE_COMPONENTS_NO_COPY: Components = {
  ...BASE_COMPONENTS,
  pre: PRE_PLAIN
}

// PERF-02：关掉 highlightAuto 的 37 语言嗅探（实测慢 18 倍）；
// detect:false 下无语言标注的围栏块由 rehype-highlight 直接跳过 → 纯文本展示（不报错）。
// 注意 ignoreMissing 不是 v7 的有效选项（已移除；未知语言默认降级为警告不抛错），不传。
const HIGHLIGHT_OPTIONS = {
  detect: false,
  subset: ['ts', 'tsx', 'js', 'jsx', 'python', 'json', 'html', 'css', 'sql', 'sh', 'yaml', 'md']
}
const REHYPE_PLUGINS_BASE: PluggableList = [[rehypeHighlight, HIGHLIGHT_OPTIONS]]
const REMARK_PLUGINS_BASE: PluggableList = [remarkGfm, remarkMath]
const REMARK_PLUGINS_CITATIONS: PluggableList = [remarkGfm, remarkMath, remarkCitations]

/** 围栏代码块：右上角「复制」按钮（含已复制反馈），按钮定位于包裹层，不随横向滚动移位；
 *  超过设置项阈值（默认 20 行，0 = 永不折叠）默认折叠，12 行预览 + 渐变遮罩 + 展开/收起条，
 *  流式中越过阈值不自动收起；改阈值会立刻让已挂载的块重新判定是否可折叠 */
const CodeBlock: React.FC<{ block: ParsedCodeBlock; children: React.ReactNode }> = ({ block, children }) => {
  const { t } = useI18n()
  const { copied, copy } = useCopyFeedback()
  const label = copied ? t('common.copied') : t('common.copy')
  const lines = countCodeLines(block.code)
  // 第三个参数是 SSR 快照：静态导出走 renderToString，缺它会抛 Missing getServerSnapshot
  const threshold = useSyncExternalStore(subscribeCodeCollapse, codeCollapseLines, codeCollapseLines)
  const canCollapse = isCollapsible(block.code, threshold)
  // 初始折叠态只在挂载时计算：流式生成中越过阈值不打断阅读，历史消息重挂即折叠
  const [collapsed, setCollapsed] = useState(() => isCollapsible(block.code, codeCollapseLines()))
  // 行高 20px；预览行数不超过阈值本身（阈值 5 行时不该露出 12 行）
  const previewMaxHeight = Math.min(CODE_PREVIEW_LINES, threshold) * 20
  return (
    <div className="relative group my-2">
      <pre
        className={`${PRE_CLASS} m-0 ${canCollapse && collapsed ? 'overflow-y-hidden' : ''}`}
        style={canCollapse && collapsed ? { maxHeight: previewMaxHeight } : undefined}
      >
        {children}
      </pre>
      {canCollapse && collapsed && (
        <div
          className="pointer-events-none absolute inset-x-0 bottom-0 h-14 rounded-b-lg bg-gradient-to-t from-[var(--hljs-bg)] to-transparent"
          aria-hidden="true"
        />
      )}
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
      {canCollapse && (
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="block w-full py-1 text-center text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
        >
          {collapsed ? t('chat.codeExpand', { n: lines }) : t('chat.codeCollapse')}
        </button>
      )}
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

  // PERF-03：rehype 插件按 katexReady 分桶缓存。katexPlugin 是模块级懒加载单例，
  // 在 setKatexReady(true) 之前必然已就位，这里读它是刻意的（不进依赖数组）。
  const rehypePlugins = useMemo<PluggableList>(() => {
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return katexReady && katexPlugin ? [katexPlugin, ...REHYPE_PLUGINS_BASE] : REHYPE_PLUGINS_BASE
  }, [katexReady])

  // PERF-03：sup 依赖 citationCount，按它分桶 useMemo；onCitation 走 ref——
  // 父组件传内联回调也不动摇 components 引用（引用一变就整棵子树重挂）。
  const onCitationRef = useRef(onCitation)
  onCitationRef.current = onCitation
  const components = useMemo<Components>(() => {
    return {
      ...(codeCopy ? BASE_COMPONENTS : BASE_COMPONENTS_NO_COPY),
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
        if (inRange && onCitationRef.current) {
          return (
            <button type="button" className={`${cls} cursor-pointer`} onClick={() => onCitationRef.current?.(n)}>
              [{n}]
            </button>
          )
        }
        return <span className={cls}>[{n}]</span>
      }
    }
  }, [codeCopy, citationCount])
  return (
    <div className="markdown-body text-[var(--chat-font-size)] leading-relaxed">
      <ReactMarkdown
        urlTransform={safeUrlTransform}
        remarkPlugins={citationCount > 0 ? REMARK_PLUGINS_CITATIONS : REMARK_PLUGINS_BASE}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
