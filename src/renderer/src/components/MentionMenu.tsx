// @ 触发面板：最近文件 / 选择新文件 / 知识库（chat 与 Agent 双侧共用）
import React, { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'

export interface MentionItem {
  type: 'recent' | 'newFile' | 'kb'
  label: string
  meta?: string
  /** 知识库 id（kb 类型）或文件名（recent 类型） */
  value: string
}

interface Props {
  items: MentionItem[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (index: number) => void
  onPickNewFile: () => void
}

export const MentionMenu: React.FC<Props> = ({ items, activeIndex, onHover, onPick, onPickNewFile }) => {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (items.length === 0) {
    return (
      <div className="absolute bottom-full left-4 right-4 mb-2 z-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] shadow-lg py-2 px-3 text-xs text-[var(--color-text-muted)]">
        {t('mention.noMatch')}
      </div>
    )
  }

  const recent = items.filter((i) => i.type === 'recent')
  const newFile = items.filter((i) => i.type === 'newFile')
  const kbs = items.filter((i) => i.type === 'kb')

  return (
    <div className="absolute bottom-full left-4 right-4 mb-2 z-20 max-h-60 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] shadow-lg py-1">
      <div ref={listRef}>
        {recent.length > 0 && (
          <>
            <div className="px-3 py-0.5 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">{t('mention.recentFiles')}</div>
            {recent.map((item, i) => renderRow(item, i, activeIndex, onHover, onPick))}
          </>
        )}
        {newFile.length > 0 && (
          <>
            {(recent.length > 0) && <div className="my-1 border-t border-[var(--color-border)]" />}
            <div className="px-3 py-0.5 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">{t('mention.newFile')}</div>
            {newFile.map((item, i) => {
              const globalIdx = recent.length + i
              return renderNewFileRow(item, globalIdx, activeIndex, onHover, onPickNewFile)
            })}
          </>
        )}
        {kbs.length > 0 && (
          <>
            {(recent.length > 0 || newFile.length > 0) && <div className="my-1 border-t border-[var(--color-border)]" />}
            <div className="px-3 py-0.5 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">{t('mention.knowledge')}</div>
            {kbs.map((item, i) => {
              const globalIdx = recent.length + newFile.length + i
              return renderRow(item, globalIdx, activeIndex, onHover, onPick)
            })}
          </>
        )}
      </div>
    </div>
  )
}

function renderRow(
  item: MentionItem,
  index: number,
  activeIndex: number,
  onHover: (i: number) => void,
  onPick: (i: number) => void
) {
  return (
    <button
      key={`${item.type}-${item.value}`}
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick(index)
      }}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
        index === activeIndex ? 'bg-[var(--color-hover-overlay)]' : ''
      }`}
    >
      <span className="text-[var(--color-accent)] font-mono text-xs">{item.type === 'kb' ? '📚' : '📄'}</span>
      <span className="text-[var(--color-text)] truncate">{item.label}</span>
      {item.meta && <span className="text-[10px] text-[var(--color-text-muted)] ml-auto shrink-0">{item.meta}</span>}
    </button>
  )
}

function renderNewFileRow(
  item: MentionItem,
  index: number,
  activeIndex: number,
  onHover: (i: number) => void,
  onPickNewFile: () => void
) {
  return (
    <button
      key="newFile"
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault()
        onPickNewFile()
      }}
      className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
        index === activeIndex ? 'bg-[var(--color-hover-overlay)]' : ''
      }`}
    >
      <span className="text-[var(--color-accent)] font-mono text-xs">+</span>
      <span className="text-[var(--color-text)] truncate">{item.label}</span>
    </button>
  )
}
