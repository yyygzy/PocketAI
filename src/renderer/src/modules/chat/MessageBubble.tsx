import React, { useState } from 'react'
import type { MessageRecord, ChatAttachment } from '../../../../shared/types'
import { Markdown } from './Markdown'

interface Props {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  model?: string | null
  messageId?: string
  attachments?: ChatAttachment[]
  selected?: boolean
  onToggleSelect?: (id: string) => void
  onCopy?: (content: string) => void
  onDelete?: (id: string) => void
  onRegenerate?: (id: string) => void
  onResend?: (id: string, newContent?: string) => void
  onFork?: (id: string) => void
  onSaveAsNote?: (id: string) => void
}

export const MessageBubble: React.FC<Props> = ({
  role,
  content,
  streaming,
  model,
  messageId,
  attachments,
  selected,
  onToggleSelect,
  onCopy,
  onDelete,
  onRegenerate,
  onResend,
  onFork,
  onSaveAsNote
}) => {
  const isUser = role === 'user'
  const [hovered, setHovered] = useState(false)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(content)
  const selectable = !!messageId && !streaming

  const handleCopy = async () => {
    if (!content) return
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      onCopy?.(content)
    }
  }

  const handleDelete = () => {
    if (messageId && onDelete) {
      onDelete(messageId)
    }
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
            onChange={() => onToggleSelect?.(messageId!)}
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
                      onResend?.(messageId!, editText.trim())
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
                  取消
                </button>
                <button
                  onClick={() => {
                    if (editText.trim() && editText.trim() !== content) {
                      setEditing(false)
                      onResend?.(messageId!, editText.trim())
                    } else {
                      setEditing(false)
                    }
                  }}
                  className="text-[11px] px-2 py-1 rounded bg-white/20 hover:bg-white/30 transition-colors"
                >
                  重发
                </button>
              </div>
            </div>
          ) : isUser ? (
            <div className="whitespace-pre-wrap text-[14px] leading-relaxed select-text">{content}</div>
          ) : content ? (
            <div className="select-text"><Markdown content={content} /></div>
          ) : streaming ? (
            <span className="inline-block w-2 h-4 bg-[var(--color-accent)] animate-pulse align-middle" />
          ) : null}
          {streaming && content && (
            <span className="inline-block w-2 h-4 ml-0.5 bg-[var(--color-accent)] animate-pulse align-middle" />
          )}
        </div>

        {/* 附件渲染 */}
        {isUser && attachments && attachments.length > 0 && !editing && (
          <div className={`flex flex-wrap gap-1.5 mt-1.5 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {attachments.map((att, i) => (
              att.type === 'image' ? (
                <img
                  key={i}
                  src={att.data}
                  alt={att.name}
                  className="w-20 h-20 object-cover rounded-lg border border-[var(--color-border)] cursor-pointer"
                  onClick={() => window.open(att.data, '_blank')}
                />
              ) : (
                <div
                  key={i}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] text-[var(--color-text-muted)]"
                  title={`${att.name} (${(att.size / 1024).toFixed(1)} KB)`}
                >
                  📄 <span className="truncate max-w-[120px] text-[var(--color-text)]">{att.name}</span>
                </div>
              )
            ))}
          </div>
        )}

        {/* 操作按钮：复制 / 编辑 / 改参重跑 / 重新生成 / 删除 */}
        {selectable && (hovered || selected) && !editing && (
          <div className={`flex gap-1 mt-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
            <button
              onClick={handleCopy}
              title="复制"
              className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
            >
              {copied ? '已复制' : '复制'}
            </button>
            {isUser && onResend && (
              <>
                <button
                  onClick={() => { setEditText(content); setEditing(true) }}
                  title="编辑后重发"
                  className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
                >
                  编辑
                </button>
                <button
                  onClick={() => onResend(messageId!)}
                  title="用当前选中的模型重新发送"
                  className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
                >
                  改参重跑
                </button>
              </>
            )}
            {!isUser && onRegenerate && (
              <button
                onClick={() => onRegenerate(messageId!)}
                title="重新生成"
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                重新生成
              </button>
            )}
            {onFork && (
              <button
                onClick={() => onFork(messageId!)}
                title="从此消息分叉出新对话"
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                分支
              </button>
            )}
            {onSaveAsNote && (
              <button
                onClick={() => onSaveAsNote(messageId!)}
                title="另存为笔记"
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                存笔记
              </button>
            )}
            <button
              onClick={handleDelete}
              title="删除"
              className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-danger-bg)] hover:text-[var(--color-danger)] transition-colors"
            >
              删除
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
