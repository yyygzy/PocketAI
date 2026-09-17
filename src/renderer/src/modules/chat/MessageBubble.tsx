import React from 'react'
import type { MessageRecord } from '../../../../shared/types'
import { Markdown } from './Markdown'

interface Props {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  model?: string | null
}

export const MessageBubble: React.FC<Props> = ({ role, content, streaming, model }) => {
  const isUser = role === 'user'

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[85%] ${isUser ? 'order-2' : ''}`}>
        {!isUser && (
          <div className="flex items-center gap-1.5 mb-1 text-[11px] text-[var(--color-text-muted)]">
            <span>🤖</span>
            {model && <span className="font-mono">{model}</span>}
          </div>
        )}
        <div
          className={`px-3.5 py-2.5 rounded-2xl ${
            isUser
              ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] rounded-br-md'
              : 'bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-bl-md'
          }`}
        >
          {isUser ? (
            <div className="whitespace-pre-wrap text-[14px] leading-relaxed">{content}</div>
          ) : content ? (
            <Markdown content={content} />
          ) : streaming ? (
            <span className="inline-block w-2 h-4 bg-[var(--color-accent)] animate-pulse align-middle" />
          ) : null}
          {streaming && content && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-[var(--color-accent)] animate-pulse align-middle" />
          )}
        </div>
      </div>
    </div>
  )
}
