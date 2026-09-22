import React from 'react'
import type { MessageRecord } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { MessageBubble } from './MessageBubble'

interface Props {
  /** 全部批次（每批 = 一次生成的回复，批内可能多条 agent 步骤消息） */
  batches: MessageRecord[][]
  /** 当前激活批次下标 */
  activeIndex: number
  /** 点击「设为当前分支」：切换该轮激活分支（随后父组件退出对比模式） */
  onActivate: (batchIndex: number) => void
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  onDelete: (id: string) => void
}

/**
 * 分支并排对比：该轮所有批次横向并排（每列 = 一个批次），列头显示模型名与
 * 激活标记，列体复用 MessageBubble 纵排。窄内容横向滚动，列最小 300px。
 */
export const BranchCompare: React.FC<Props> = ({
  batches,
  activeIndex,
  onActivate,
  selectedIds,
  onToggleSelect,
  onDelete
}) => {
  const { t } = useI18n()
  return (
    <div className="-mx-1 px-1 overflow-x-auto pb-1">
      <div
        className="grid gap-3 items-start"
        style={{ gridTemplateColumns: `repeat(${batches.length}, minmax(300px, 1fr))` }}
      >
        {batches.map((batch, bi) => {
          const label = batch
            .map((r) => r.model)
            .filter(Boolean)
            .join(' · ')
          const active = bi === activeIndex
          return (
            <div
              key={batch[0]?.id ?? `cmp-${bi}`}
              className={`rounded-lg border p-2 min-w-0 flex flex-col gap-1 transition-colors ${
                active
                  ? 'border-[var(--color-accent)] bg-[var(--color-accent-bg)]'
                  : 'border-[var(--color-border)] bg-[var(--color-hover-overlay)]'
              }`}
            >
              {/* 列头：模型名 + 激活标记 + 设为当前 */}
              <div className="flex items-center gap-1.5 px-1 pt-0.5 text-[11px] text-[var(--color-text-muted)]">
                <span className="font-mono truncate flex-1 min-w-0" title={label || t('chat.branchUntitled')}>
                  {active && <span className="text-[var(--color-accent)] mr-1">●</span>}
                  {label || t('chat.branchUntitled')}
                </span>
                {active ? (
                  <span className="shrink-0 text-[var(--color-accent)]">{t('chat.branchActive')}</span>
                ) : (
                  <button
                    onClick={() => onActivate(bi)}
                    title={t('chat.branchSetActive')}
                    className="shrink-0 px-1.5 py-0.5 rounded border border-[var(--color-border)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)] transition-colors"
                  >
                    {t('chat.branchSetActive')}
                  </button>
                )}
              </div>
              {/* 列体：批内消息纵排 */}
              <div className="flex flex-col gap-1">
                {batch.map((r) => (
                  <MessageBubble
                    key={r.id}
                    role="assistant"
                    content={r.content}
                    model={r.model}
                    streaming={r.status === 'streaming'}
                    messageId={r.id}
                    selected={selectedIds.has(r.id)}
                    onToggleSelect={onToggleSelect}
                    onDelete={onDelete}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
