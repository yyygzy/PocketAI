import React from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

export const Markdown: React.FC<{ content: string }> = ({ content }) => {
  return (
    <div className="markdown-body text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          a: ({ node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" className="text-[var(--color-accent)] underline" />
          ),
          pre: ({ children }) => (
            <pre className="rounded-lg p-3 overflow-x-auto text-[13px] my-2 bg-[var(--hljs-bg)] text-[var(--hljs-text)]">{children}</pre>
          ),
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
