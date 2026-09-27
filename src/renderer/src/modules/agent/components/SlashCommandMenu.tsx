// 斜杠快捷指令弹出菜单：输入 / 时浮于输入框上方，↑↓/Enter/Tab/鼠标选择
import React, { useEffect, useRef } from 'react'
import type { SlashCommand } from '../agent-shared'

interface Props {
  commands: SlashCommand[]
  activeIndex: number
  onHover: (index: number) => void
  onPick: (index: number) => void
}

export const SlashCommandMenu: React.FC<Props> = ({ commands, activeIndex, onHover, onPick }) => {
  const listRef = useRef<HTMLDivElement>(null)

  // 选中项滚动到可视区（长列表键盘导航）
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (commands.length === 0) return null

  return (
    <div
      className="absolute bottom-full left-11 right-12 mb-2 z-20 max-h-60 overflow-y-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-sidebar)] shadow-lg py-1"
      role="listbox"
    >
      <div ref={listRef}>
        {commands.map((c, i) => (
          <button
            key={c.name}
            type="button"
            role="option"
            aria-selected={i === activeIndex}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              // mousedown 避免 textarea 先 blur 导致菜单消失
              e.preventDefault()
              onPick(i)
            }}
            className={`w-full flex flex-col items-start gap-0.5 px-3 py-1.5 text-left text-sm transition-colors ${
              i === activeIndex ? 'bg-[var(--color-hover-overlay)]' : ''
            }`}
          >
            <span className="flex items-center gap-1.5">
              <span className="text-[var(--color-accent)] font-mono text-xs">/{c.name}</span>
              <span className="text-[var(--color-text)]">{c.label}</span>
            </span>
            <span className="text-xs text-[var(--color-text-muted)] line-clamp-1">{c.template}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
