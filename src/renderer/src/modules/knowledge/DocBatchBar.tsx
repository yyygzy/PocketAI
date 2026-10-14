// 文档列表的批量操作条：状态由 KbDetail 持有，本组件只负责"能点什么、点谁"。
//
// 抽成独立组件的用例价值：它可以在没有 confirm/toast/十几条 IPC 的情况下真挂载，
// 于是「按钮什么时候该禁用」「失败项计数从哪来」这类判断是可断言的，而不是靠肉眼点。
import React from 'react'
import type { KbDocument } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { errorDocIds } from './doc-batch'

export interface DocBatchBarProps {
  /** 列表里的全部文档（用来数失败篇数与全选范围） */
  docs: KbDocument[]
  /** 是否处于批量模式：非批量模式下只给一个「批量操作」入口 */
  batchMode: boolean
  selected: string[]
  busy: boolean
  onEnter: () => void
  onExit: () => void
  onSelectMode: (mode: 'all' | 'errors') => void
  onClear: () => void
  onReindex: (ids: string[]) => void
  onSetEnabled: (ids: string[], enabled: boolean) => void
  /** 不可逆动作：调用方必须先确认，本组件不代替确认 */
  onDelete: (ids: string[]) => void
}

export const DocBatchBar: React.FC<DocBatchBarProps> = ({
  docs,
  batchMode,
  selected,
  busy,
  onEnter,
  onExit,
  onSelectMode,
  onClear,
  onReindex,
  onSetEnabled,
  onDelete
}) => {
  const { t } = useI18n()
  const errorIds = errorDocIds(docs)
  const hasSelection = selected.length > 0
  const actDisabled = busy || !hasSelection
  const btn = 'btn-ghost text-xs disabled:opacity-50'

  if (!batchMode) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          onClick={onEnter}
          disabled={busy || docs.length === 0}
          className={btn}
          title={t('kb.batchHint')}
        >
          {t('kb.batchMode')}
        </button>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-3 py-2 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)]">
      <span className="text-xs font-medium">{t('kb.batchSelected', { n: selected.length })}</span>
      <button onClick={() => onSelectMode('all')} disabled={busy || docs.length === 0} className={btn}>
        {t('kb.batchSelectAll')}
      </button>
      {errorIds.length > 0 && (
        <button onClick={() => onSelectMode('errors')} disabled={busy} className={btn}>
          {t('kb.batchSelectErrors', { n: errorIds.length })}
        </button>
      )}
      <button onClick={onClear} disabled={busy || !hasSelection} className={btn}>
        {t('kb.batchClear')}
      </button>

      <span className="mx-1 h-4 w-px bg-[var(--color-border)]" aria-hidden="true" />

      <button onClick={() => onReindex(selected)} disabled={actDisabled} className={btn}>
        {t('kb.reindex')}
      </button>
      <button onClick={() => onSetEnabled(selected, true)} disabled={actDisabled} className={btn}>
        {t('kb.batchEnable')}
      </button>
      <button onClick={() => onSetEnabled(selected, false)} disabled={actDisabled} className={btn}>
        {t('kb.batchDisable')}
      </button>
      <button
        onClick={() => onDelete(selected)}
        disabled={actDisabled}
        className="btn-ghost text-xs text-[var(--color-danger)] disabled:opacity-50"
      >
        {t('common.delete')}
      </button>

      <span className="flex-1" />

      {errorIds.length > 0 && (
        <button
          onClick={() => onReindex(errorIds)}
          disabled={busy}
          className="btn-ghost text-xs disabled:opacity-50"
        >
          {t('kb.batchRetryErrors', { n: errorIds.length })}
        </button>
      )}
      <button onClick={onExit} disabled={busy} className={btn}>
        {t('kb.batchExit')}
      </button>
    </div>
  )
}

export default DocBatchBar
