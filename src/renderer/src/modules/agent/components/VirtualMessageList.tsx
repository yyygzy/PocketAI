// 虚拟消息列表：用 @tanstack/react-virtual 只渲染可视区消息，避免长对话 DOM 线性增长
// 滚底逻辑：流式追加时若用户在底部锚定区则自动跟滚；用户主动向上滚后停止跟滚（尊重阅读）
import React, { useEffect, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AgentMessageCard } from './AgentMessageCard'
import { isNearBottom, shouldStickToBottom } from './virtual-list-utils'
import { useI18n } from '../../../i18n'
import type { AgentMessage } from '../agent-shared'
import type { ReactNode } from 'react'

export interface VirtualMessageListProps {
  messages: AgentMessage[]
  /** 是否流式中（流式追加时按 isAtBottom 决定跟滚） */
  running: boolean
  /** 当前会话 id（切换时一次性滚底，不触发跟滚抖动；null 表示无会话） */
  conversationId: string | null
  /** 空列表时渲染的提示节点 */
  emptyHint: ReactNode
  /** 删除单条消息（非流式时由父级传入） */
  onDeleteMessage?: (id: string) => void
  /** 截断重跑某条用户消息（非流式时由父级传入）；overrideText 非空为编辑后重发 */
  onRerunMessage?: (id: string, overrideText?: string) => void
  /** 重新生成最后一条 final 助手回复（非流式时由父级传入） */
  onRegenerateMessage?: (id: string) => void
  /** 搜索定位：需要滚动到的消息下标（变化时居中滚动） */
  focusIndex?: number | null
  /** 搜索定位：当前高亮的消息 id（外层卡片加 ring） */
  highlightId?: string | null
}

export const VirtualMessageList: React.FC<VirtualMessageListProps> = ({
  messages,
  running,
  conversationId,
  emptyHint,
  onDeleteMessage,
  onRerunMessage,
  onRegenerateMessage,
  focusIndex,
  highlightId
}) => {
  const { t } = useI18n()
  const scrollRef = useRef<HTMLDivElement>(null)
  // 用户是否处于底部锚定区（历史状态，scroll 事件更新）
  const isAtBottomRef = useRef(true)
  // 切会话后待滚底标记：messages 异步加载，length 变化 effect 里消费
  const pendingScrollBottomRef = useRef(true)
  // 滚出底部锚定区时显示「回到底部」悬浮按钮
  const [showJumpBottom, setShowJumpBottom] = useState(false)

  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    // 以消息 id 为 key：删除中间消息后高度缓存跟随消息而非索引，避免卡片位置错乱/重叠
    getItemKey: (index) => messages[index]?.id ?? index,
    estimateSize: () => 60,
    overscan: 6,
    measureElement: (el) => {
      // 基于 ResizeObserver 自动测量动态高度（消息含 markdown/图片/代码块）
      return el instanceof HTMLElement ? el.getBoundingClientRect().height : 60
    }
  })

  const handleScroll = () => {
    const el = scrollRef.current
    if (!el) return
    const atBottom = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight, 48)
    isAtBottomRef.current = atBottom
    setShowJumpBottom(!atBottom)
  }

  /** 点击悬浮按钮：立即滚到底并恢复流式跟滚 */
  const jumpToBottom = () => {
    if (messages.length === 0) return
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })
    isAtBottomRef.current = true
    setShowJumpBottom(false)
  }

  // 切会话：设待滚底标记（不立即滚，messages 可能尚未加载完）
  useEffect(() => {
    pendingScrollBottomRef.current = true
    isAtBottomRef.current = true
    setShowJumpBottom(false)
  }, [conversationId])

  // 搜索定位：focusIndex 变化时居中滚动到该消息（独立于跟滚逻辑，不改变 isAtBottom）
  useEffect(() => {
    if (focusIndex == null || focusIndex < 0 || focusIndex >= messages.length) return
    virtualizer.scrollToIndex(focusIndex, { align: 'center' })
  }, [focusIndex, virtualizer, messages.length])

  // 消息数变化或流式状态变化：按待滚底标记 / 跟滚规则决定是否滚到底
  useEffect(() => {
    const count = messages.length
    if (count === 0) return
    const lastIndex = count - 1
    if (pendingScrollBottomRef.current) {
      virtualizer.scrollToIndex(lastIndex, { align: 'end' })
      pendingScrollBottomRef.current = false
      isAtBottomRef.current = true
      setShowJumpBottom(false)
      return
    }
    if (shouldStickToBottom(isAtBottomRef.current, isAtBottomRef.current, running)) {
      virtualizer.scrollToIndex(lastIndex, { align: 'end' })
      setShowJumpBottom(false)
    }
  }, [messages.length, running, virtualizer])

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-[var(--color-text-muted)]">
        {emptyHint}
      </div>
    )
  }

  const items = virtualizer.getVirtualItems()
  const totalHeight = virtualizer.getTotalSize()

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="absolute inset-0 overflow-y-auto space-y-2 pr-1"
      >
        <div style={{ position: 'relative', height: totalHeight, width: '100%' }}>
          {items.map((vi) => {
            const m = messages[vi.index]
            if (!m) return null
            // 仅最后一条 final 助手卡提供「重新生成」（重跑其前最近的用户消息）
            const isLastFinal =
              vi.index === messages.length - 1 && m.role === 'assistant' && m.isFinal
            return (
              <div
                key={m.id}
                data-index={vi.index}
                ref={virtualizer.measureElement}
                className={
                  highlightId === m.id
                    ? 'rounded-lg ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-bg)] transition-shadow'
                    : undefined
                }
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  transform: `translateY(${vi.start}px)`,
                  width: '100%',
                  // pb-2 模拟原 space-y-2 的项间距（absolute 元素 margin 不生效，用 padding 计入测量高度）
                  paddingBottom: 8
                }}
              >
                <AgentMessageCard
                  m={m}
                  onDelete={onDeleteMessage}
                  onRerun={onRerunMessage}
                  onRegenerate={isLastFinal ? onRegenerateMessage : undefined}
                />
              </div>
            )
          })}
        </div>
      </div>
      {showJumpBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          title={t('agent.jumpToBottom')}
          aria-label={t('agent.jumpToBottom')}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 px-2.5 py-1 rounded-full text-xs shadow-md border border-[var(--color-border)] bg-[var(--color-sidebar)] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
        >
          <span aria-hidden>↓</span>
          {t('agent.jumpToBottom')}
        </button>
      )}
    </div>
  )
}
