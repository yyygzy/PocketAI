import React, { useState } from 'react'
import type { ChatAttachment, MessageSource } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { CopyButton } from '../../components/CopyButton'
import { requestSourceJump } from '../knowledge/source-jump'
import { AttachmentGrid } from '../../components/AttachmentGrid'
import { Markdown } from './Markdown'

interface Props {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  model?: string | null
  messageId: string
  attachments?: ChatAttachment[]
  sources?: MessageSource[]
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onDelete?: (id: string) => void
  onRegenerate?: (id: string) => void
  onResend?: (id: string, newContent?: string) => void
  onFork?: (id: string) => void
  onSaveAsNote?: (id: string) => void
}

/** React.memo：流式输出时只重渲染变化的消息，其余消息 props 不变即跳过（配合 ChatView 的 useCallback） */
const MessageBubbleImpl: React.FC<Props> = ({
  role,
  content,
  streaming,
  model,
  messageId,
  attachments,
  sources,
  selected,
  onToggleSelect,
  onDelete,
  onRegenerate,
  onResend,
  onFork,
  onSaveAsNote
}) => {
  const { t } = useI18n()
  const isUser = role === 'user'
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(content)
  const [showSources, setShowSources] = useState(false)
  const selectable = !!messageId && !streaming

  const handleDelete = () => {
    if (messageId && onDelete) {
      onDelete(messageId)
    }
  }

  /** 正文 [n] 引用徽章点击：展开来源块并滚动定位到第 n 条 */
  const handleCitation = (n: number) => {
    setShowSources(true)
    requestAnimationFrame(() => {
      document
        .getElementById(`kb-source-${messageId}-${n}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
    })
  }

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} group relative`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* 选择框（非 user 流式消息可选中） */}
      {selectable && (
        <div className={`flex items-center ${isUser ? 'order-1 mr-2' : 'order-1 mr-2'}`}>
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onToggleSelect?.(messageId)}
            className={`w-4 h-4 rounded cursor-pointer accent-[var(--color-accent)] ${hovered || selected ? 'opacity-100' : 'opacity-0'} transition-opacity`}
          />
        </div>
      )}

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
          } ${selected ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
        >
          {editing && isUser ? (
            <div className="flex flex-col gap-2">
              <textarea
                className="w-full bg-transparent border border-white/30 rounded-lg px-2 py-1.5 text-[14px] leading-relaxed resize-none outline-none min-h-[60px] max-h-[200px]"
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    if (editText.trim() && editText.trim() !== content) {
                      setEditing(false)
                      onResend?.(messageId, editText.trim())
                    }
                  }
                  if (e.key === 'Escape') {
                    setEditing(false)
                  }
                }}
              />
              <div className="flex gap-1.5 justify-end">
                <button
                  onClick={() => setEditing(false)}
                  className="text-[11px] px-2 py-1 rounded bg-white/10 hover:bg-white/20 transition-colors"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={() => {
                    if (editText.trim() && editText.trim() !== content) {
                      setEditing(false)
                      onResend?.(messageId, editText.trim())
                    } else {
                      setEditing(false)
                    }
                  }}
                  className="text-[11px] px-2 py-1 rounded bg-white/20 hover:bg-white/30 transition-colors"
                >
                  {t('chatview.resend')}
                </button>
              </div>
            </div>
          ) : isUser ? (
            <div className="whitespace-pre-wrap text-[14px] leading-relaxed select-text">{content}</div>
          ) : content ? (
            <div className="select-text">
              <Markdown
                content={content}
                citationCount={sources?.length ?? 0}
                onCitation={handleCitation}
              />
            </div>
          ) : streaming ? (
            <span className="inline-block w-2 h-4 bg-[var(--color-accent)] animate-pulse align-middle" />
          ) : null}
          {streaming && content && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-[var(--color-accent)] animate-pulse align-middle" />
          )}
        </div>

        {/* 知识库引用来源 */}
        {!isUser && sources && sources.length > 0 && (
          <div className="mt-1.5">
            <button
              onClick={() => setShowSources((v) => !v)}
              className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
            >
              <span>{showSources ? '▼' : '▶'}</span>
              <span>{t('chatview.sources', { count: sources.length })}</span>
            </button>
            {showSources && (
              <div className="mt-1.5 flex flex-col gap-1.5">
                {sources.map((s, i) => (
                  <div
                    key={s.chunkId}
                    id={`kb-source-${messageId}-${i + 1}`}
                    className="px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] scroll-mt-2"
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="shrink-0 text-[10px] px-1 rounded border border-[var(--color-border)] text-[var(--color-accent)] font-medium">
                        [{i + 1}]
                      </span>
                      <span className="text-[11px] text-[var(--color-accent)] font-medium truncate">
                        {s.docTitle}
                      </span>
                      {s.kbId && s.seq !== undefined && (
                        <button
                          onClick={() =>
                            requestSourceJump({ kbId: s.kbId!, docId: s.docId, seq: s.seq! })
                          }
                          title={t('chatview.viewSource')}
                          aria-label={t('chatview.viewSource')}
                          className="ml-auto shrink-0 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                        >
                          ↗
                        </button>
                      )}
                    </div>
                    <div className="text-[12px] text-[var(--color-text-muted)] mt-0.5 line-clamp-2">
                      {s.content.slice(0, 120)}{s.content.length > 120 ? '…' : ''}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 附件渲染 */}
        {isUser && attachments && attachments.length > 0 && !editing && (
          <AttachmentGrid attachments={attachments} align="end" />
        )}

        {/* 操作按钮：复制 / 编辑 / 改参重跑 / 重新生成 / 删除 */}
        {selectable && (hovered || selected) && !editing && (
          <div className={`flex gap-1 mt-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <CopyButton
              text={content}
              className="chip"
            />
            {isUser && onResend && (
              <>
                <button
                  onClick={() => { setEditText(content); setEditing(true) }}
                  title={t('chatview.editResendTitle')}
                  className="chip chip-accent"
                >
                  {t('chatview.editResend')}
                </button>
                <button
                  onClick={() => onResend(messageId)}
                  title={t('chatview.resendModelTitle')}
                  className="chip chip-accent"
                >
                  {t('chatview.rerun')}
                </button>
              </>
            )}
            {!isUser && onRegenerate && (
              <button
                onClick={() => onRegenerate(messageId)}
                title={t('chatview.regenerate')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                {t('chatview.regenerate')}
              </button>
            )}
            {onFork && (
              <button
                onClick={() => onFork(messageId)}
                title={t('chatview.forkTitle')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                {t('chatview.fork')}
              </button>
            )}
            {onSaveAsNote && (
              <button
                onClick={() => onSaveAsNote(messageId)}
                title={t('chatview.saveNoteTitle')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                {t('chatview.saveNote')}
              </button>
            )}
            <button
              onClick={handleDelete}
              title={t('common.delete')}
              className="chip chip-danger"
            >
              {t('common.delete')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export const MessageBubble = React.memo(MessageBubbleImpl)
