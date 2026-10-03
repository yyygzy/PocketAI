// 通用斜杠/片段快捷菜单（chat 与 Agent 双侧共用）
import React, { useEffect, useRef } from 'react'
import { useI18n } from '../i18n'
import type { SlashCommand } from '../utils/snippet-slash'

interface Props {
  commands: SlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (index: number) => void
}

export const SlashMenu: React.FC<Props> = ({ commands, activeIndex, onHover, onPick }) => {
  const { t } = useI18n()
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) {
    return (
      <div className="absolute bottom-full left-4 right-4 mb-2 z-20 rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] shadow-lg py-2 px-3 text-xs text-[var(--color-text-muted)]">
        {t('slash.noMatch')}
      </div>
    )
  }

  // 分组：builtin 在前，snippet 在后
  const builtins = commands.filter((c) => c.kind === 'builtin')
  const snippets = commands.filter((c) => c.kind === 'snippet')

  return (
    <div className="absolute bottom-full left-4 right-4 mb-2 z-20 max-h-60 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] shadow-lg py-1">
      <div ref={listRef}>
        {builtins.length > 0 && (
          <>
            <div className="px-3 py-0.5 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
              {t('slash.section.builtin')}
            </div>
            {builtins.map((c, i) => renderItem(c, i, activeIndex, onHover, onPick))}
          </>
        )}
        {snippets.length > 0 && (
          <>
            {builtins.length > 0 && <div className="my-1 border-t border-[var(--color-border)]" />}
            <div className="px-3 py-0.5 text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider">
              {t('slash.section.snippets')}
            </div>
            {snippets.map((c, i) => {
              const globalIdx = builtins.length + i
              return renderItem(c, globalIdx, activeIndex, onHover, onPick)
            })}
          </>
        )}
      </div>
      <div className="px-3 py-1 border-t border-[var(--color-border)] text-[10px] text-[var(--color-text-muted)]">
        {t('slash.hint')}
      </div>
    </div>
  )
}

function renderItem(
  c: SlashCommand,
  index: number,
  activeIndex: number,
  onHover: (i: number) => void,
  onPick: (i: number) => void
) {
  return (
    <button
      key={c.name}
      type="button"
      role="option"
      aria-selected={index === activeIndex}
      onMouseEnter={() => onHover(index)}
      onMouseDown={(e) => {
        e.preventDefault()
        onPick(index)
      }}
      className={`w-full flex flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm transition-colors ${
        index === activeIndex ? 'bg-[var(--color-hover-overlay)]' : ''
      }`}
    >
      <span className="flex items-center gap-1.5">
        <span className="text-[var(--color-accent)] font-mono text-xs">
          {c.kind === 'builtin' ? `/${c.name}` : `#${c.label}`}
        </span>
        {c.kind === 'builtin' && <span className="text-[var(--color-text)]">{c.label}</span>}
      </span>
      <span className="text-xs text-[var(--color-text-muted)] line-clamp-1">{c.template}</span>
    </button>
  )
}
