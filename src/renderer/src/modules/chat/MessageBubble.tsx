import React, { useEffect, useState } from 'react'
import type { ChatAttachment, MessageRecord, MessageSource, UsagePricing, UsageStats } from '../../../../shared/types'
import { computeUsageCost, priceKey } from '../../../../shared/usage-pricing'
import { useI18n } from '../../i18n'
import { CopyButton } from '../../components/CopyButton'
import { requestSourceJump } from '../knowledge/source-jump'
import { AttachmentGrid } from '../../components/AttachmentGrid'
import { ReminderMenu } from '../../components/ReminderMenu'
import { Markdown } from './Markdown'
import { fmtTokens, fmtCost } from '../../utils/token'
import { formatDateTime } from '../../utils/time'
import { writeClipboard } from '../../utils/clipboard'
import { isTtsSupported, speak, stop, subscribeSpeak, stripSpeechText } from '../../utils/tts'

interface Props {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  model?: string | null
  messageId: string
  /** 消息创建时间（用于 hover 时间戳 tooltip） */
  createdAt?: number
  attachments?: ChatAttachment[]
  sources?: MessageSource[]
  selected?: boolean
  /** 搜索跳转临时高亮（ring 闪烁动画，2s 后由父组件清除） */
  highlight?: boolean
  /** 本条 assistant 消息的 token 用量（done 重载后带值，流式中为 null） */
  usage?: UsageStats | null
  /** 本条消息的 provider id（配合 model + pricing 计算气泡费用） */
  provider?: string | null
  /** 本机单价配置（缺省/拉取失败时只显示 token 数） */
  pricing?: UsagePricing | null
  /** range=true 表示 Shift+点击（由父级执行锚点范围连选） */
  onToggleSelect?: (id: string, range?: boolean) => void
  onDelete?: (id: string) => void
  onRegenerate?: (id: string) => void
  onResend?: (id: string, newContent?: string) => void
  onFork?: (id: string) => void
  onSaveAsNote?: (id: string) => void
  /** 本条消息引用的被引用消息（用于顶部引用条） */
  replyTo?: MessageRecord | null
  /** 点击引用条跳转到被引用消息 */
  onJumpToReply?: (id: string) => void
  /** 引用本条消息（设置 Composer 引用状态）；父级通过 id 查找完整消息 */
  onReply?: (id: string) => void
  /** 转发本条消息到其他会话；父级通过 id 查找完整消息 */
  onForward?: (id: string) => void
  /** 收藏星标状态（starred 时常显 ⭐，不依赖 hover） */
  starred?: boolean
  /** 切换收藏星标 */
  onToggleStar?: (id: string, starred: boolean) => void
  /** 多选模式：禁用右键菜单（与点选操作冲突） */
  selectMode?: boolean
  /** 基于本条消息创建定时提醒（右键「提醒我」；ChatModule 提供，Agent 侧不传） */
  onRemind?: (id: string, fireAt: number) => void
}

/** React.memo：流式输出时只重渲染变化的消息，其余消息 props 不变即跳过（配合 ChatView 的 useCallback） */
const MessageBubbleImpl: React.FC<Props> = ({
  role,
  content,
  streaming,
  model,
  messageId,
  createdAt,
  attachments,
  sources,
  selected,
  highlight,
  usage,
  provider,
  pricing,
  onToggleSelect,
  onDelete,
  onRegenerate,
  onResend,
  onFork,
  onSaveAsNote,
  replyTo,
  onJumpToReply,
  onReply,
  onForward,
  starred,
  onToggleStar,
  selectMode,
  onRemind
}) => {
  const { t, lang } = useI18n()
  const isUser = role === 'user'
  const [hovered, setHovered] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editText, setEditText] = useState(content)
  const [showSources, setShowSources] = useState(false)
  const selectable = !!messageId && !streaming
  // 右键菜单：点项即执行，点击外部/Esc 关闭
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  // 「提醒我」时间预设浮层锚点
  const [remindMenu, setRemindMenu] = useState<{ x: number; y: number } | null>(null)
  // 用量详情弹窗
  const [usageModal, setUsageModal] = useState(false)
  // TTS：全局单例当前朗读的消息 id（仅 assistant 非流式可朗读）
  const ttsSupported = isTtsSupported()
  const canSpeak = ttsSupported && !isUser && !streaming && !!content.trim()
  const [speakingId, setSpeakingId] = useState<string | null>(null)
  useEffect(() => subscribeSpeak((s) => setSpeakingId(s?.id ?? null)), [])
  // 卸载时若朗读的是本条则停止（切会话/虚拟列表回收）
  useEffect(() => () => stop(messageId), [messageId])
  const speaking = speakingId === messageId
  const toggleSpeak = () => {
    if (speaking) stop()
    else speak(messageId, stripSpeechText(content), lang)
  }

  // token 微展示：仅 done 且带 usage 的 assistant 消息渲染；命中本机单价时附带估算费用
  const unitPrice =
    !isUser && usage && pricing && provider && model
      ? pricing.prices[priceKey(provider, model)]
      : undefined
  const costValue = usage && unitPrice ? computeUsageCost(usage, unitPrice) : 0
  const costText = fmtCost(costValue)
  const currencySymbol = pricing?.currency === 'USD' ? '$' : '¥'
  const tokenHint = usage
    ? [
        t('chatview.tokenHint', { prompt: usage.promptTokens, completion: usage.completionTokens }),
        usage.cachedTokens && usage.cachedTokens > 0 ? t('chatview.tokenCachedHint', { cached: usage.cachedTokens }) : '',
        costText ? `${currencySymbol}${costText}` : ''
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  const handleDelete = () => {
    if (messageId && onDelete) {
      onDelete(messageId)
    }
  }

  // 右键菜单打开时 Esc 关闭（点击外部由透明 overlay 承接）
  useEffect(() => {
    if (!ctxMenu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setCtxMenu(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ctxMenu])

  /** 右键菜单项：复刻 hover 操作区（按 props 可用性过滤），点项即执行并关闭 */
  const ctxItems: { key: string; label: string; danger?: boolean; onClick: () => void }[] = []
  if (ctxMenu) {
    ctxItems.push({ key: 'copy', label: t('common.copy'), onClick: () => void writeClipboard(content) })
    if (canSpeak) {
      ctxItems.push({
        key: 'speak',
        label: speaking ? t('chat.stopSpeak') : t('chat.speak'),
        onClick: toggleSpeak
      })
    }
    if (onReply) ctxItems.push({ key: 'reply', label: t('chat.reply'), onClick: () => onReply(messageId) })
    if (onForward) ctxItems.push({ key: 'forward', label: t('chat.forward'), onClick: () => onForward(messageId) })
    if (isUser && onResend) {
      ctxItems.push({ key: 'edit', label: t('chatview.editResend'), onClick: () => { setEditText(content); setEditing(true) } })
      ctxItems.push({ key: 'rerun', label: t('chatview.rerun'), onClick: () => onResend(messageId) })
    }
    if (!isUser && onRegenerate) ctxItems.push({ key: 'regen', label: t('chatview.regenerate'), onClick: () => onRegenerate(messageId) })
    if (onFork) ctxItems.push({ key: 'fork', label: t('chatview.fork'), onClick: () => onFork(messageId) })
    if (onSaveAsNote) ctxItems.push({ key: 'note', label: t('chatview.saveNote'), onClick: () => onSaveAsNote(messageId) })
    if (onRemind)
      ctxItems.push({
        key: 'remind',
        label: `⏰ ${t('reminder.menu.remindMe')}`,
        onClick: () => setRemindMenu({ x: ctxMenu.x, y: ctxMenu.y })
      })
    if (onToggleStar) ctxItems.push({ key: 'star', label: starred ? t('chat.unstar') : t('chat.star'), onClick: () => onToggleStar(messageId, !starred) })
    if (onDelete) ctxItems.push({ key: 'del', label: t('common.delete'), danger: true, onClick: handleDelete })
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
      onContextMenu={(e) => {
        if (!selectable || editing || selectMode) return
        e.preventDefault()
        e.stopPropagation()
        setCtxMenu({ x: e.clientX, y: e.clientY })
      }}
      title={createdAt ? formatDateTime(createdAt) : undefined}
    >
      {/* 选择框（非 user 流式消息可选中） */}
      {selectable && (
        <div className={`flex items-center ${isUser ? 'order-1 mr-2' : 'order-1 mr-2'}`}>
          <input
            type="checkbox"
            checked={!!selected}
            // change 事件不带 shiftKey，用 click 捕获 Shift 连选（键盘空格触发的 click 视为普通点选）
            onClick={(e) => onToggleSelect?.(messageId, e.shiftKey)}
            onChange={() => { /* 受控组件占位，选中逻辑在 onClick */ }}
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
        {/* 引用条：本条消息引用的被引用消息预览，点击跳转 */}
        {replyTo && (
          <button
            onClick={() => onJumpToReply?.(replyTo.id)}
            className={`block w-full text-left mb-1.5 px-2.5 py-1.5 rounded-lg text-[11px] line-clamp-2 break-all transition-colors ${
              isUser
                ? 'bg-white/15 text-white/80 hover:bg-white/25'
                : 'bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)] hover:bg-[var(--color-border)]'
            }`}
            title={t('chat.jumpToReply')}
          >
            <span className="font-medium mr-1">
              {replyTo.role === 'user' ? t('chat.you') : t('chat.assistant')}:
            </span>
            {replyTo.content || t('chat.replyEmpty')}
          </button>
        )}
        <div
          className={`px-3.5 py-2.5 rounded-2xl ${
            isUser
              ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] rounded-br-md'
              : 'bg-[var(--color-sidebar)] border border-[var(--color-border)] rounded-bl-md'
          } ${selected ? 'ring-2 ring-[var(--color-accent)]' : ''} ${
            highlight ? 'ring-2 ring-[var(--color-warning)] animate-pulse' : ''
          }`}
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
            <div className="whitespace-pre-wrap text-[var(--chat-font-size)] leading-relaxed select-text">{content}</div>
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

        {/* token 微展示：总量 + 命中单价时的估算费用，点击展开详情弹窗 */}
        {!isUser && usage && !streaming && (
          <div
            className="mt-1 text-[10px] text-[var(--color-text-muted)] font-mono cursor-pointer hover:opacity-80"
            title={tokenHint ? `${tokenHint}\n${t('chat.usageDetailHint')}` : t('chat.usageDetailHint')}
            onClick={() => setUsageModal(true)}
          >
            {t('chatview.tokenLine', { tokens: fmtTokens(usage.totalTokens) })}
            {costText && <span className="ml-1.5 text-[var(--color-accent)]">{currencySymbol}{costText}</span>}
          </div>
        )}

        {/* 附件渲染 */}
        {isUser && attachments && attachments.length > 0 && !editing && (
          <AttachmentGrid attachments={attachments} align="end" />
        )}

        {/* 操作按钮：复制 / 引用 / 编辑 / 改参重跑 / 重新生成 / 删除 / 收藏星标（已收藏常显） */}
        {selectable && (hovered || selected || starred || speaking) && !editing && (
          <div className={`flex gap-1 mt-1 ${isUser ? 'justify-end' : 'justify-start'}`}>
            {(hovered || selected) && (
              <>
            <CopyButton
              text={content}
              className="chip"
            />
            {onReply && (
              <button
                onClick={() => onReply(messageId)}
                title={t('chat.reply')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                {t('chat.reply')}
              </button>
            )}
            {onForward && (
              <button
                onClick={() => onForward(messageId)}
                title={t('chat.forward')}
                aria-label={t('chat.forward')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                ↪
              </button>
            )}
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
            {canSpeak && !speaking && (
              <button
                onClick={toggleSpeak}
                title={t('chat.speak')}
                aria-label={t('chat.speak')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
              >
                🔊
              </button>
            )}
            <button
              onClick={handleDelete}
              title={t('common.delete')}
              className="chip chip-danger"
            >
              {t('common.delete')}
            </button>
              </>
            )}
            {canSpeak && speaking && (
              <button
                onClick={toggleSpeak}
                title={t('chat.stopSpeak')}
                aria-label={t('chat.stopSpeak')}
                className="text-[11px] px-1.5 py-0.5 rounded text-[var(--color-accent)] hover:bg-[var(--color-hover-overlay)] transition-colors animate-pulse"
              >
                ⏹
              </button>
            )}
            {onToggleStar && (
              <button
                onClick={() => onToggleStar(messageId, !starred)}
                title={starred ? t('chat.unstar') : t('chat.star')}
                aria-label={starred ? t('chat.unstar') : t('chat.star')}
                className={`text-[11px] px-1.5 py-0.5 rounded transition-colors ${starred ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)]'}`}
              >
                {starred ? '⭐' : '☆'}
              </button>
            )}
          </div>
        )}
      </div>
      {/* 右键菜单：fixed 定位 + 视口边缘 clamp，透明 overlay 承接外部点击/再次右键 */}
      {ctxMenu && (
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
      )}

      {/* 「提醒我」时间预设浮层：选择后交父级按消息 id 取正文建提醒 */}
      {remindMenu && onRemind && (
        <ReminderMenu
          anchor={remindMenu}
          onClose={() => setRemindMenu(null)}
          onPick={(fireAt) => {
            setRemindMenu(null)
            onRemind(messageId, fireAt)
          }}
        />
      )}

      {/* 消息级用量弹窗：token 分解 + 命中单价 + 估算费用 */}
      {usageModal && usage && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setUsageModal(false)}>
          <div className="w-80 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-semibold mb-3">{t('chat.usageDetail')}</h3>
            {(provider || model) && (
              <div className="text-xs mb-3 text-[var(--color-text-muted)] font-mono truncate" title={`${provider ?? ''} / ${model ?? ''}`}>
                {provider}{provider && model ? ' / ' : ''}{model}
              </div>
            )}
            <div className="space-y-1.5 text-xs font-mono">
              <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{t('chat.tokensIn')}</span><span>{fmtTokens(usage.promptTokens)}</span></div>
              <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{t('chat.tokensOut')}</span><span>{fmtTokens(usage.completionTokens)}</span></div>
              {!!usage.cachedTokens && usage.cachedTokens > 0 && (
                <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{t('chat.tokensCached')}</span><span>{fmtTokens(usage.cachedTokens)}</span></div>
              )}
              <div className="flex justify-between border-t border-[var(--color-border)] pt-1.5"><span className="text-[var(--color-text-muted)]">{t('chat.tokensTotal')}</span><span className="font-semibold">{fmtTokens(usage.totalTokens)}</span></div>
            </div>
            {unitPrice ? (
              <div className="mt-3 space-y-1.5 text-xs font-mono">
                <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{t('usage.priceInput')}</span><span>{currencySymbol}{unitPrice.input}/1M</span></div>
                <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{t('usage.priceOutput')}</span><span>{currencySymbol}{unitPrice.output}/1M</span></div>
                {unitPrice.cache !== undefined && (
                  <div className="flex justify-between"><span className="text-[var(--color-text-muted)]">{t('usage.priceCache')}</span><span>{currencySymbol}{unitPrice.cache}/1M</span></div>
                )}
                <div className="flex justify-between border-t border-[var(--color-border)] pt-1.5"><span className="text-[var(--color-text-muted)]">{t('usage.cost')}</span><span className="font-semibold text-[var(--color-accent)]">{currencySymbol}{costText}</span></div>
              </div>
            ) : (
              <div className="mt-3 text-[11px] text-[var(--color-text-muted)]">{t('chat.usageNoPrice')}</div>
            )}
            <div className="flex justify-end mt-4">
              <button onClick={() => setUsageModal(false)} className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover)]">
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export const MessageBubble = React.memo(MessageBubbleImpl)
