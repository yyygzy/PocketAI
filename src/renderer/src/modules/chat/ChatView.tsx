import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderRecord, MessageRecord, ChatTarget, ChatAttachment, AssistantRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { ModelSelector } from './ModelSelector'
import { MessageBubble } from './MessageBubble'
import { ComparisonColumns, type CompareColumn } from './ComparisonColumns'
import { Composer } from './Composer'
import { ChatConfigBar } from './ChatConfigBar'

interface Turn {
  user: MessageRecord | null
  replies: MessageRecord[]
}

interface Props {
  providers: ProviderRecord[]
  targets: ChatTarget[]
  onTargetsChange: (t: ChatTarget[]) => void
  messages: MessageRecord[]
  liveColumns: CompareColumn[] | null
  welcomeMessage?: string
  assistantName?: string
  assistant: AssistantRecord | null
  onAssistantUpdated: (a: AssistantRecord) => void
  onSend: (text: string, attachments?: ChatAttachment[]) => void
  onStop: () => void
  onRegenerate: (messageId: string) => void
  onResend: (messageId: string, newContent?: string) => void
  onDeleteMessage: (id: string) => void
  onDeleteMessages: (ids: string[]) => void
  onForkConversation?: (messageId: string) => void
  onSaveAsNote?: (messageId: string) => void
}

export const ChatView: React.FC<Props> = ({
  providers,
  targets,
  onTargetsChange,
  messages,
  liveColumns,
  welcomeMessage,
  assistantName,
  assistant,
  onAssistantUpdated,
  onSend,
  onStop,
  onRegenerate,
  onResend,
  onDeleteMessage,
  onDeleteMessages,
  onForkConversation,
  onSaveAsNote
}) => {
  const { t } = useI18n()
  const bottomRef = useRef<HTMLDivElement>(null)
  const streaming = liveColumns !== null
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  // 切换会话时清空选择
  useEffect(() => {
    setSelectedIds(new Set())
  }, [messages.length === 0])

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAll = () => {
    const allIds = messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => m.id)
    setSelectedIds(new Set(allIds))
  }

  const clearSelection = () => setSelectedIds(new Set())

  const handleCopySelected = async () => {
    const selected = messages.filter((m) => selectedIds.has(m.id))
    const text = selected
      .map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`)
      .join('\n\n')
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // ignore
    }
  }

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return
    onDeleteMessages(Array.from(selectedIds))
    setSelectedIds(new Set())
  }

  const handleDeleteOne = (id: string) => {
    onDeleteMessage(id)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }

  const handleCopyFallback = (content: string) => {
    // clipboard API 失败时的降级
    const ta = document.createElement('textarea')
    ta.value = content
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* ignore */ }
    document.body.removeChild(ta)
  }

  // 扁平消息 → 轮次分组
  const turns = useMemo<Turn[]>(() => {
    const result: Turn[] = []
    for (const m of messages) {
      if (m.role === 'user') {
        result.push({ user: m, replies: [] })
      } else if (m.role === 'assistant') {
        const last = result[result.length - 1]
        if (last) last.replies.push(m)
        else result.push({ user: null, replies: [m] })
      }
    }
    return result
  }, [messages])

  // 实时流作为虚拟回复挂到最后一轮（乐观 user 消息此时无回复）
  const renderedTurns: Turn[] = useMemo(() => {
    if (!liveColumns) return turns
    const virtualReplies: MessageRecord[] = liveColumns.map((c, i) => ({
      id: `live-${i}`,
      conversationId: '',
      role: 'assistant',
      content: c.content,
      provider: c.providerId,
      model: c.model,
      status: c.status,
      parentId: null,
      createdAt: Date.now()
    }))
    const copy = [...turns]
    const last = copy[copy.length - 1]
    if (last && last.user && last.replies.length === 0) {
      last.replies = virtualReplies
    } else {
      copy.push({ user: null, replies: virtualReplies })
    }
    return copy
  }, [turns, liveColumns])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [renderedTurns.length, liveColumns])

  const canSend = targets.length > 0 && targets.every((t) => t.providerId && t.model)

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* 顶部模型选择栏 */}
      <div className="shrink-0 min-h-12 flex items-center px-4 border-b border-[var(--color-border)] py-1.5">
        <ModelSelector
          providers={providers}
          targets={targets}
          onChange={onTargetsChange}
          disabled={streaming}
        />
      </div>

      {/* 批量操作栏（选中消息时显示） */}
      {selectedIds.size > 0 && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-hover-overlay)]">
          <span className="text-xs text-[var(--color-text-muted)]">
            已选 {selectedIds.size} 条
          </span>
          <button
            onClick={selectAll}
            className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors"
          >
            全选
          </button>
          <button
            onClick={handleCopySelected}
            className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors"
          >
            复制选中
          </button>
          <button
            onClick={handleDeleteSelected}
            className="text-xs px-2 py-1 rounded text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors"
          >
            删除选中
          </button>
          <button
            onClick={clearSelection}
            className="text-xs px-2 py-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-sidebar)] transition-colors ml-auto"
          >
            取消
          </button>
        </div>
      )}

      {/* 消息流 */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-4 py-5 space-y-6">
          {renderedTurns.length === 0 && (
            <div className="flex flex-col items-center justify-center h-72 text-center px-6">
              <div className="text-4xl mb-3">🎒</div>
              {assistantName && <p className="text-[var(--color-text)] font-semibold">{assistantName}</p>}
              {welcomeMessage ? (
                <p className="text-sm text-[var(--color-text-muted)] mt-2 max-w-md leading-relaxed whitespace-pre-wrap">
                  {welcomeMessage}
                </p>
              ) : (
                <p className="text-sm text-[var(--color-text-muted)] mt-2">{t('chatview.start')}</p>
              )}
              <p className="text-[11px] text-[var(--color-text-muted)] mt-3">
                {t('chatview.hint')}
              </p>
            </div>
          )}

          {renderedTurns.map((turn, ti) => (
            <div key={turn.user?.id ?? `turn-${ti}`} className="space-y-4">
              {turn.user && (
                <MessageBubble
                  role="user"
                  content={turn.user.content}
                  messageId={turn.user.id}
                  attachments={turn.user.attachments}
                  selected={selectedIds.has(turn.user.id)}
                  onToggleSelect={toggleSelect}
                  onCopy={handleCopyFallback}
                  onDelete={handleDeleteOne}
                  onResend={onResend}
                  onFork={onForkConversation}
                  onSaveAsNote={onSaveAsNote}
                />
              )}
              {turn.replies.length === 1 ? (
                <MessageBubble
                  role="assistant"
                  content={turn.replies[0].content}
                  model={turn.replies[0].model}
                  streaming={turn.replies[0].status === 'streaming'}
                  messageId={turn.replies[0].id}
                  selected={selectedIds.has(turn.replies[0].id)}
                  onToggleSelect={toggleSelect}
                  onCopy={handleCopyFallback}
                  onDelete={handleDeleteOne}
                  onRegenerate={onRegenerate}
                  onFork={onForkConversation}
                  onSaveAsNote={onSaveAsNote}
                />
              ) : turn.replies.length > 1 ? (
                <ComparisonColumns
                  providers={providers}
                  columns={turn.replies.map((r) => ({
                    providerId: r.provider ?? '',
                    model: r.model ?? '',
                    content: r.content,
                    status: r.status === 'streaming' ? 'streaming' : r.status === 'error' ? 'error' : r.status === 'aborted' ? 'aborted' : 'done'
                  }))}
                  messageIds={turn.replies.map((r) => r.id)}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onCopy={handleCopyFallback}
                  onDelete={handleDeleteOne}
                />
              ) : null}
            </div>
          ))}

          <div ref={bottomRef} />
        </div>
      </div>

      <Composer streaming={streaming} canSend={canSend} onSend={onSend} onStop={onStop} />

      {/* 输入框下方：对话配置条（技能/知识库/工具权限/临时提示词） */}
      <div className="shrink-0 px-4 pb-3">
        <ChatConfigBar
          assistant={assistant}
          onAssistantUpdated={onAssistantUpdated}
        />
      </div>
    </div>
  )
}
