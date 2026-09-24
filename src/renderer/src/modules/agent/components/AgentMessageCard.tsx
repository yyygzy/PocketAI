// Agent 对话消息卡：用户 / tool_call / tool_result / assistant（含思考折叠、沙箱操作）
// React.memo：流式 chunk 只更新对应消息对象，其余卡片引用不变直接跳过重渲染
import React, { useState } from 'react'
import { useI18n } from '../../../i18n'
import { CopyButton } from '../../../components/CopyButton'
import { extractFirstHtmlBlock, type AgentMessage } from '../agent-shared'
import { HtmlBlockActions } from './HtmlBlockActions'

const cardBtnClass = 'text-[10px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors'

const AgentMessageCardImpl: React.FC<{ m: AgentMessage }> = ({ m }) => {
  const { t } = useI18n()
  const [showReasoning, setShowReasoning] = useState(false)

  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="bg-[var(--color-accent-soft)] px-3 py-2 rounded-lg max-w-[80%] text-sm select-text">
          {m.text}
          {/* 附件渲染 */}
          {m.attachments && m.attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1.5 justify-end">
              {m.attachments.map((att, i) => (
                att.type === 'image' ? (
                  <img key={i} src={att.data} alt={att.name} className="w-16 h-16 object-cover rounded border border-[var(--color-border)]" />
                ) : (
                  <span key={i} className="text-[11px] bg-white/10 px-1.5 py-0.5 rounded">📄 {att.name}</span>
                )
              ))}
            </div>
          )}
          <div className="flex justify-end mt-1">
            <CopyButton text={m.text} className={cardBtnClass} />
          </div>
        </div>
      </div>
    )
  }

  if (m.role === 'tool' && m.toolCall) {
    return (
      <div className="text-xs px-3 py-2 rounded border border-[var(--color-info-bg)] bg-[var(--color-info-bg)]">
        <div className="text-[var(--color-info)] font-mono">{t('agent.callTool', { name: m.toolCall.function.name })}</div>
        <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap break-all">
          {m.toolCall.function.arguments}
        </pre>
        <div className="flex justify-end mt-1">
          <CopyButton text={m.toolCall.function.arguments} className={cardBtnClass} />
        </div>
      </div>
    )
  }

  if (m.role === 'tool' && m.toolResult) {
    return (
      <div className={`text-xs px-3 py-2 rounded border ${m.isError ? 'border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)]' : 'border-[var(--color-success-bg)] bg-[var(--color-success-bg)]'}`}>
        <div className={`font-mono ${m.isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>
          {m.isError ? t('agent.toolError') : t('agent.toolResult')}: {m.toolResult.name}
        </div>
        <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
          {m.toolResult.content}
        </pre>
        <div className="flex justify-end mt-1">
          <CopyButton text={m.toolResult.content} className={cardBtnClass} />
        </div>
      </div>
    )
  }

  // 任务清单卡（todo_write）：状态图标 + 进度计数，同一次运行内整卡更新
  if (m.role === 'assistant' && m.todos && m.todos.length > 0) {
    const done = m.todos.filter((item) => item.status === 'completed').length
    return (
      <div className="px-3 py-2 rounded-lg border border-[var(--color-info-bg)] bg-[var(--color-info-bg)] text-sm max-w-[80%]">
        <div className="flex justify-between items-center mb-1.5">
          <span className="text-xs text-[var(--color-info)] font-medium">{t('agent.todoTitle')}</span>
          <span className="text-[10px] text-[var(--color-text-muted)]">
            {t('agent.todoProgress', { done, total: m.todos.length })}
          </span>
        </div>
        <ul className="space-y-1">
          {m.todos.map((item, i) => (
            <li key={i} className="flex items-start gap-2 text-[13px]">
              <span className="shrink-0">
                {item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '▶' : '□'}
              </span>
              <span className={item.status === 'completed' ? 'line-through text-[var(--color-text-muted)]' : ''}>
                {item.content}
              </span>
            </li>
          ))}
        </ul>
      </div>
    )
  }

  // assistant
  const htmlBlock = m.isFinal && m.text ? extractFirstHtmlBlock(m.text) : null
  return (
    <div className={`px-3 py-2 rounded-lg text-sm select-text ${m.isFinal ? 'bg-[var(--color-hover-overlay)]' : 'bg-[var(--color-input-bg)]'}`}>
      {/* 思考过程（可折叠） */}
      {m.reasoning && m.reasoning.trim() && (
        <div className="mb-2">
          <button
            onClick={() => setShowReasoning((v) => !v)}
            className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] flex items-center gap-1"
          >
            <span>{showReasoning ? '▼' : '▶'}</span>
            <span>{t('agent.thinking')}（{m.reasoning.length} 字）</span>
          </button>
          {showReasoning && (
            <div className="mt-1 px-2 py-1.5 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)] text-[12px] text-[var(--color-text-muted)] whitespace-pre-wrap max-h-60 overflow-y-auto">
              {m.reasoning}
            </div>
          )}
        </div>
      )}
      {m.isFinal && <div className="text-[10px] text-[var(--color-accent)] mb-1">{t('agent.finalAnswer')}</div>}
      <div className={`whitespace-pre-wrap ${m.isError ? 'text-[var(--color-danger)]' : ''}`}>{m.text || (m.isFinal ? '' : t('agent.thinking'))}</div>
      {htmlBlock && <HtmlBlockActions htmlBlock={htmlBlock} />}
      {m.text && (
        <div className="flex justify-end mt-1">
          <CopyButton text={m.text} className={cardBtnClass} />
        </div>
      )}
    </div>
  )
}

export const AgentMessageCard = React.memo(AgentMessageCardImpl)
