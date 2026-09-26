// 消息全文搜索结果区：Chat 侧栏与 Agent 侧栏共享
// 含 PUA 高亮令牌渲染、相对时间、按会话分组
import React from 'react'
import type { MessageSearchResult } from '../../../shared/types'
import { SNIPPET_MARK_OPEN, SNIPPET_MARK_CLOSE } from '../../../shared/snippet'
import { useI18n } from '../i18n'
import { EmptyState } from './EmptyState'

/** 将「纯文本 + PUA 高亮令牌」片段渲染为 React 节点：
 *  全程文本节点，任何 HTML/脚本字符都按字面显示，无注入面 */
export const HighlightedSnippet: React.FC<{ text: string }> = ({ text }) => {
  const segments = text.split(SNIPPET_MARK_OPEN)
  return (
    <>
      {segments.map((seg, i) => {
        if (i === 0) return <React.Fragment key={i}>{seg}</React.Fragment>
        const at = seg.indexOf(SNIPPET_MARK_CLOSE)
        if (at < 0) return <React.Fragment key={i}>{seg}</React.Fragment>
        return (
          <React.Fragment key={i}>
            <mark className="bg-[var(--color-accent-soft)] text-[var(--color-text)] rounded px-0.5 font-medium">
              {seg.slice(0, at)}
            </mark>
            {seg.slice(at + SNIPPET_MARK_CLOSE.length)}
          </React.Fragment>
        )
      })}
    </>
  )
}

/** Unix 毫秒时间戳 → 相对人类可读时间（1分钟前、2小时前、昨天、日期） */
export function relTime(ts: number, t: (k: string, p?: Record<string, string | number>) => string): string {
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60_000)
  if (m < 1) return t('chat.justNow')
  if (m < 60) return t('chat.minutesAgo', { n: m })
  const h = Math.floor(m / 60)
  if (h < 24) return t('chat.hoursAgo', { n: h })
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return t('chat.today')
  const y = new Date(now.getTime() - 86_400_000)
  if (d.toDateString() === y.toDateString()) return t('chat.yesterday')
  return `${d.getMonth() + 1}/${d.getDate()}`
}

export const MessageSearchResults: React.FC<{
  results: MessageSearchResult[]
  searching: boolean
  query: string
  onSelectConv: (convId: string) => void
}> = ({ results, searching, query, onSelectConv }) => {
  const { t } = useI18n()
  if (searching) {
    return <EmptyState className="text-xs text-[var(--color-text-muted)] text-center mt-6" message={t('chat.searching')} />
  }
  if (results.length === 0) {
    return <EmptyState className="text-xs text-[var(--color-text-muted)] text-center mt-6 px-2" message={t('chat.noResult', { query })} />
  }
  // 按 conversationId 分组
  const grouped = new Map<string, { title: string; items: MessageSearchResult[] }>()
  for (const r of results) {
    const g = grouped.get(r.conversationId) ?? { title: r.conversationTitle, items: [] }
    g.items.push(r)
    grouped.set(r.conversationId, g)
  }
  return (
    <>
      <p className="text-[11px] text-[var(--color-text-muted)] px-1 py-1">{t('chat.resultCount', { n: results.length, m: grouped.size })}</p>
      {[...grouped.entries()].map(([convId, group]) => (
        <div key={convId} className="mb-2">
          <button
            onClick={() => onSelectConv(convId)}
            className="w-full text-left text-[11px] text-[var(--color-accent)] px-2 py-0.5 hover:underline truncate"
            title={group.title}
          >
            📁 {group.title}
          </button>
          {group.items.map((r) => (
            <div
              key={r.messageId}
              onClick={() => onSelectConv(r.conversationId)}
              className="text-[11px] px-2.5 py-1.5 rounded cursor-pointer hover:bg-[var(--color-hover-overlay)] border border-transparent hover:border-[var(--color-border)]"
            >
              <div className="flex items-center gap-1 mb-0.5">
                <span className={`inline-block text-[var(--color-text-muted)] ${r.role === 'user' ? 'text-[var(--color-info)]' : r.role === 'assistant' ? 'text-[var(--color-success)]' : ''}`}>
                  {r.role === 'user' ? t('chat.roleYou') : r.role === 'assistant' ? t('chat.roleAI') : r.role}
                </span>
                <span className="text-[var(--color-text-muted)] opacity-60">· {relTime(r.createdAt, t)}</span>
              </div>
              <span className="text-[var(--color-text)] leading-snug"><HighlightedSnippet text={r.snippet} /></span>
            </div>
          ))}
        </div>
      ))}
    </>
  )
}
