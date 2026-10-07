// Agent 对话消息卡：用户 / tool_call / tool_result / assistant（含思考折叠、沙箱操作）
// React.memo：流式 chunk 只更新对应消息对象，其余卡片引用不变直接跳过重渲染
import React, { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../../i18n'
import { CopyButton } from '../../../components/CopyButton'
import { AttachmentGrid } from '../../../components/AttachmentGrid'
import { extractFirstHtmlBlock, type AgentMessage } from '../agent-shared'
import { HtmlBlockActions } from './HtmlBlockActions'
import { writeClipboard } from '../../../utils/clipboard'
import { ReminderMenu } from '../../../components/ReminderMenu'

const cardBtnClass = 'text-[10px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors'

/** 卡片操作区：重新生成（可选）+ 重跑（可选）+ 复制 + 删除（删除仅非流式时由父级传入） */
const CardActions: React.FC<{
  copyText: string
  onDelete?: () => void
  onRerun?: () => void
  onRegenerate?: () => void
}> = ({ copyText, onDelete, onRerun, onRegenerate }) => {
  const { t } = useI18n()
  return (
    <div className="flex justify-end gap-1 mt-1">
      {onRegenerate && (
        <button
          onClick={onRegenerate}
          className={`${cardBtnClass} hover:text-[var(--color-accent)]`}
          title={t('agent.regenerate')}
          aria-label={t('agent.regenerate')}
        >
          ↻ {t('agent.regenerate')}
        </button>
      )}
      {onRerun && (
        <button
          onClick={onRerun}
          className={`${cardBtnClass} hover:text-[var(--color-accent)]`}
          title={t('agent.rerun')}
          aria-label={t('agent.rerun')}
        >
          ↻ {t('agent.rerun')}
        </button>
      )}
      <CopyButton text={copyText} className={cardBtnClass} />
      {onDelete && (
        <button
          onClick={onDelete}
          className={`${cardBtnClass} hover:text-[var(--color-danger)]`}
          title={t('common.delete')}
          aria-label={t('common.delete')}
        >
          {t('common.delete')}
        </button>
      )}
    </div>
  )
}

/** 用户卡正文：默认展示，编辑态切换为 textarea + 保存/取消（editing 状态由父级托管，右键菜单可触发） */
const UserCardBody: React.FC<{
  m: AgentMessage
  editing: boolean
  onEditingChange: (v: boolean) => void
  onDelete?: () => void
  onRerun?: (id: string, overrideText?: string) => void
}> = ({ m, editing, onEditingChange, onDelete, onRerun }) => {
  const { t } = useI18n()
  const [draft, setDraft] = useState(m.text)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (editing) {
      setDraft(m.text)
      taRef.current?.focus()
      taRef.current?.setSelectionRange(m.text.length, m.text.length)
    }
  }, [editing, m.text])

  const canEdit = Boolean(onRerun && m.dbId)
  const submit = () => {
    const next = draft.trim()
    if (next && next !== m.text.trim()) onRerun?.(m.id, next)
    onEditingChange(false)
  }

  if (editing) {
    return (
      <div className="w-full min-w-[240px]">
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            } else if (e.key === 'Escape') {
              onEditingChange(false)
            }
          }}
          rows={Math.min(8, Math.max(2, draft.split('\n').length))}
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-input-bg)] px-2 py-1 text-sm outline-none focus:border-[var(--color-accent)]"
        />
        <div className="flex justify-end gap-1 mt-1">
          <button onClick={() => onEditingChange(false)} className={cardBtnClass}>
            {t('common.cancel')}
          </button>
          <button onClick={submit} disabled={!draft.trim()} className={`${cardBtnClass} hover:text-[var(--color-accent)] disabled:opacity-40`}>
            {t('common.save')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      {m.text}
      {m.attachments && m.attachments.length > 0 && <AttachmentGrid attachments={m.attachments} align="end" />}
      <div className="flex justify-end gap-1 mt-1">
        {canEdit && (
          <button
            onClick={() => onEditingChange(true)}
            className={`${cardBtnClass} hover:text-[var(--color-accent)]`}
            title={t('common.edit')}
            aria-label={t('common.edit')}
          >
            {t('common.edit')}
          </button>
        )}
        <CardActions
          copyText={m.text}
          onDelete={onDelete}
          onRerun={canEdit ? () => onRerun?.(m.id) : undefined}
        />
      </div>
    </>
  )
}

const AgentMessageCardImpl: React.FC<{
  m: AgentMessage
  onDelete?: (id: string) => void
  onRerun?: (id: string, overrideText?: string) => void
  /** 重新生成（父级仅对最后一条 final 助手消息传入） */
  onRegenerate?: (id: string) => void
  /** 右键「提醒我」：父级按 id 取正文并调 IPC 建提醒（与 Chat 同链路） */
  onRemind?: (id: string, fireAt: number) => void
}> = ({ m, onDelete, onRerun, onRegenerate, onRemind }) => {
  const { t } = useI18n()
  const [showReasoning, setShowReasoning] = useState(false)
  const [showSources, setShowSources] = useState(false)
  // 用户卡编辑态提升到本层：右键菜单「编辑」可直接进入编辑
  const [editing, setEditing] = useState(false)
  // 右键菜单：点项即执行，点击外部/Esc 关闭（与 Chat MessageBubble 同模式）
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const [remindMenu, setRemindMenu] = useState<{ x: number; y: number } | null>(null)
  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setCtxMenu(null); setRemindMenu(null) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctxMenu])
  const del = onDelete ? () => onDelete(m.id) : undefined
  const canEditUser = m.role === 'user' && Boolean(onRerun && m.dbId)
  // 运行中父级不传 onDelete（AgentPanel: running → undefined），据此禁用右键；编辑态同样不弹
  const canCtx = Boolean(del) && !editing

  /** 右键菜单项：按角色过滤（复制/编辑/重跑/重新生成/删除/提醒我），点项即执行并关闭 */
  const buildCtxItems = (): { key: string; label: string; danger?: boolean; onClick: () => void }[] => {
    const items: { key: string; label: string; danger?: boolean; onClick: () => void }[] = []
    if (m.role === 'user') {
      if (m.text) items.push({ key: 'copy', label: t('common.copy'), onClick: () => void writeClipboard(m.text) })
      if (canEditUser) items.push({ key: 'edit', label: t('common.edit'), onClick: () => setEditing(true) })
      if (canEditUser) items.push({ key: 'rerun', label: t('agent.rerun'), onClick: () => onRerun?.(m.id) })
    } else if (m.role === 'tool' && m.toolCall) {
      items.push({ key: 'copy', label: t('common.copy'), onClick: () => void writeClipboard(m.toolCall!.function.arguments) })
    } else if (m.role === 'tool' && m.toolResult) {
      items.push({ key: 'copy', label: t('common.copy'), onClick: () => void writeClipboard(m.toolResult!.content) })
    } else if (m.role === 'assistant') {
      if (m.text) items.push({ key: 'copy', label: t('common.copy'), onClick: () => void writeClipboard(m.text) })
      if (m.isFinal && onRegenerate) items.push({ key: 'regen', label: t('agent.regenerate'), onClick: () => onRegenerate(m.id) })
    }
    if (onRemind && (m.role === 'user' || m.role === 'assistant') && m.text) {
      items.push({
        key: 'remind',
        label: `⏰ ${t('reminder.menu.remindMe')}`,
        onClick: () => setRemindMenu({ x: ctxMenu!.x, y: ctxMenu!.y })
      })
    }
    if (del) items.push({ key: 'del', label: t('common.delete'), danger: true, onClick: del })
    return items
  }

  const handleCtx = (e: React.MouseEvent) => {
    if (!canCtx) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  const ctxItems = ctxMenu ? buildCtxItems() : []
  /** 右键菜单节点：fixed 定位 + 视口边缘 clamp，透明 overlay 承接外部点击/再次右键 */
  const ctxMenuNode = ctxMenu && ctxItems.length > 0 ? (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={() => setCtxMenu(null)}
        onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null) }}
      />
      <div
        className="fixed z-50 min-w-[140px] py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        style={{
          left: Math.min(ctxMenu.x, window.innerWidth - 160),
          top: Math.min(ctxMenu.y, window.innerHeight - ctxItems.length * 30 - 16)
        }}
      >
        {ctxItems.map((item) => (
          <button
            key={item.key}
            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
              item.danger
                ? 'text-[var(--color-danger)] hover:bg-[var(--color-hover-overlay)]'
                : 'text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)]'
            }`}
            onClick={() => { setCtxMenu(null); item.onClick() }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </>
  ) : null

  /** 提醒时间预设浮层：选择后交父级按消息 id 取正文建提醒（与 Chat 同链路） */
  const remindMenuNode = remindMenu && onRemind ? (
    <ReminderMenu
      anchor={remindMenu}
      onClose={() => setRemindMenu(null)}
      onPick={(fireAt) => {
        setRemindMenu(null)
        onRemind(m.id, fireAt)
      }}
    />
  ) : null

  if (m.role === 'user') {
    return (
      <div className="flex justify-end" onContextMenu={handleCtx}>
        <div className="bg-[var(--color-accent-soft)] px-3 py-2 rounded-lg max-w-[80%] text-sm select-text">
          <UserCardBody m={m} editing={editing} onEditingChange={setEditing} onDelete={del} onRerun={onRerun} />
        </div>
        {ctxMenuNode}
        {remindMenuNode}
      </div>
    )
  }

  if (m.role === 'tool' && m.toolCall) {
    return (
      <div className="text-xs px-3 py-2 rounded border border-[var(--color-info-bg)] bg-[var(--color-info-bg)]" onContextMenu={handleCtx}>
        <div className="text-[var(--color-info)] font-mono">{t('agent.callTool', { name: m.toolCall.function.name })}</div>
        <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap break-all">
          {m.toolCall.function.arguments}
        </pre>
        <CardActions copyText={m.toolCall.function.arguments} onDelete={del} />
        {ctxMenuNode}
      </div>
    )
  }

  if (m.role === 'tool' && m.toolResult) {
    return (
      <div className={`text-xs px-3 py-2 rounded border ${m.isError ? 'border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)]' : 'border-[var(--color-success-bg)] bg-[var(--color-success-bg)]'}`} onContextMenu={handleCtx}>
        <div className={`font-mono ${m.isError ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'}`}>
          {m.isError ? t('agent.toolError') : t('agent.toolResult')}: {m.toolResult.name}
        </div>
        <pre className="mt-1 text-[10px] text-[var(--color-text-muted)] whitespace-pre-wrap break-all max-h-40 overflow-y-auto">
          {m.toolResult.content}
        </pre>
        <CardActions copyText={m.toolResult.content} onDelete={del} />
        {ctxMenuNode}
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
    <div className={`px-3 py-2 rounded-lg text-sm select-text ${m.isFinal ? 'bg-[var(--color-hover-overlay)]' : 'bg-[var(--color-input-bg)]'}`} onContextMenu={handleCtx}>
      {/* 思考过程（可折叠） */}
      {m.reasoning && m.reasoning.trim() && (
        <div className="mb-2">
          <div className="flex items-center justify-between gap-1">
            <button
              onClick={() => setShowReasoning((v) => !v)}
              className="text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] flex items-center gap-1"
            >
              <span>{showReasoning ? '▼' : '▶'}</span>
              <span>{t('agent.thinking')}（{m.reasoning.length} 字）</span>
            </button>
            {/* 思考过程单独复制（纯思考卡无正文时这是唯一复制入口） */}
            <CopyButton text={m.reasoning} title={t('agent.copyReasoning')} className={cardBtnClass} />
          </div>
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
      {/* 知识库引用来源 */}
      {m.sources && m.sources.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowSources((v) => !v)}
            className="flex items-center gap-1 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
          >
            <span>{showSources ? '▼' : '▶'}</span>
            <span>{t('chatview.sources', { count: m.sources.length })}</span>
          </button>
          {showSources && (
            <div className="mt-1.5 flex flex-col gap-1.5">
              {m.sources.map((s, i) => (
                <div
                  key={s.chunkId}
                  className="px-2.5 py-1.5 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)]"
                >
                  <div className="text-[11px] text-[var(--color-accent)] font-medium truncate">
                    {i + 1}. {s.docTitle}
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
      {m.text && (
        <CardActions
          copyText={m.text}
          onDelete={del}
          onRegenerate={m.isFinal && onRegenerate ? () => onRegenerate(m.id) : undefined}
        />
      )}
      {ctxMenuNode}
      {remindMenuNode}
    </div>
  )
}

export const AgentMessageCard = React.memo(AgentMessageCardImpl)
