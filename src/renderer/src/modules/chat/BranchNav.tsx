import React from 'react'
import { useI18n } from '../../i18n'

interface Props {
  /** 当前分支下标（0-based） */
  index: number
  total: number
  /** 当前分支的模型标签（多个模型用 · 连接） */
  label?: string | null
  onPrev: () => void
  onNext: () => void
}

/** 消息分支切换条：‹ 2/3 › · 模型名（类似 ChatGPT 的多版本回复导航） */
export const BranchNav: React.FC<Props> = ({ index, total, label, onPrev, onNext }) => {
  const { t } = useI18n()
  const btnCls =
    'w-5 h-5 flex items-center justify-center rounded text-[12px] leading-none text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] disabled:opacity-30 disabled:hover:bg-transparent transition-colors'
  return (
    <div className="flex items-center justify-center gap-1 mt-1.5 text-[11px] text-[var(--color-text-muted)]">
      <button onClick={onPrev} disabled={index <= 0} title={t('chat.branchPrev')} className={btnCls}>
        ‹
      </button>
      <span className="tabular-nums" title={t('chat.branchHint')}>
        {t('chat.branchPos', { i: index + 1, n: total })}
      </span>
      <button onClick={onNext} disabled={index >= total - 1} title={t('chat.branchNext')} className={btnCls}>
        ›
      </button>
      {label && (
        <span className="ml-1 font-mono truncate max-w-[280px]" title={label}>
          {label}
        </span>
      )}
    </div>
  )
}
