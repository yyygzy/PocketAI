// 全局命令面板（Ctrl/⌘+P）：模糊子串搜索会话（Chat/Agent）/助手/知识库/功能模块，
// 键盘 ↑↓ 选择、Enter 执行、Esc/点遮罩关闭。打开时懒加载四源数据（本次打开缓存）。
// 跨模块导航经 utils/palette-nav 的 pending + 事件总线（目标模块未挂载也能兜底）。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useAppStore } from '../store/app-store'
import { COMMAND_PALETTE_EVENT } from '../hooks/useGlobalShortcuts'
import {
  filterPaletteItems,
  nextPaletteIndex,
  type PaletteItem,
  type PaletteType
} from '../utils/command-palette'
import { requestOpenConversation, requestOpenKb } from '../utils/palette-nav'
import type { ModuleId } from './Sidebar'

const CONV_PREVIEW_LIMIT = 30

/** 功能模块项（标题走 tab.* i18n；chat/agent 已在会话/助手区覆盖，此处不重复列） */
const PALETTE_MODULES: ModuleId[] = [
  'knowledge', 'skills', 'notes', 'files', 'translate', 'image', 'sandbox', 'terminal', 'steward', 'settings'
]

const MODULE_TITLE_KEY: Record<ModuleId, string> = {
  chat: 'tab.newChat',
  agent: 'tab.newAgent',
  skills: 'tab.skills',
  knowledge: 'tab.knowledge',
  files: 'tab.files',
  notes: 'tab.notes',
  translate: 'tab.translate',
  image: 'tab.image',
  sandbox: 'tab.sandbox',
  terminal: 'tab.terminal',
  steward: 'tab.steward',
  settings: 'tab.settings'
}

/** 分组展示顺序与标题 key */
const GROUPS: { type: PaletteType; labelKey: string; icon: string }[] = [
  { type: 'conv-chat', labelKey: 'palette.groupConvChat', icon: '💬' },
  { type: 'conv-agent', labelKey: 'palette.groupConvAgent', icon: '🤖' },
  { type: 'assistant', labelKey: 'palette.groupAssistant', icon: '🧑‍🏫' },
  { type: 'kb', labelKey: 'palette.groupKb', icon: '📚' },
  { type: 'module', labelKey: 'palette.groupModule', icon: '⚡' }
]

export const CommandPalette: React.FC = () => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<PaletteItem[]>([])
  const [loading, setLoading] = useState(false)
  const [activeIdx, setActiveIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // 中枢派发事件 → 开面板（重复按 Ctrl+P 仅聚焦输入框）
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(COMMAND_PALETTE_EVENT, onOpen)
    return () => window.removeEventListener(COMMAND_PALETTE_EVENT, onOpen)
  }, [])

  // 打开：重置查询 + 懒加载数据源（失败源静默为空，不阻断其余分组）
  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIdx(0)
    let cancelled = false
    setLoading(true)
    void Promise.allSettled([
      window.pocketai.listConversations(undefined, false, false),
      window.pocketai.listConversations(undefined, true, false),
      window.pocketai.listAssistants(),
      window.pocketai.listKnowledgeBases()
    ]).then(([chatR, agentR, asstR, kbR]) => {
      if (cancelled) return
      const chat = chatR.status === 'fulfilled' ? chatR.value : []
      const agent = agentR.status === 'fulfilled' ? agentR.value : []
      const assistants = asstR.status === 'fulfilled' ? asstR.value : []
      const kbs = kbR.status === 'fulfilled' ? kbR.value : []
      const next: PaletteItem[] = []
      for (const c of chat.slice(0, CONV_PREVIEW_LIMIT)) {
        next.push({ id: c.id, type: 'conv-chat', title: c.title, subtitle: c.lastMessagePreview ?? undefined, assistantId: c.assistantId ?? undefined })
      }
      for (const c of agent.slice(0, CONV_PREVIEW_LIMIT)) {
        next.push({ id: c.id, type: 'conv-agent', title: c.title, subtitle: c.lastMessagePreview ?? undefined, assistantId: c.assistantId ?? undefined })
      }
      for (const a of assistants) {
        next.push({ id: a.id, type: 'assistant', title: a.name, subtitle: a.description || undefined })
      }
      for (const kb of kbs) {
        next.push({ id: kb.id, type: 'kb', title: kb.name, subtitle: kb.description || undefined })
      }
      for (const m of PALETTE_MODULES) {
        next.push({ id: m, type: 'module', title: t(MODULE_TITLE_KEY[m]), moduleId: m })
      }
      setItems(next)
      setLoading(false)
    })
    requestAnimationFrame(() => inputRef.current?.focus())
    return () => { cancelled = true }
  }, [open, t])

  const filtered = useMemo(() => filterPaletteItems(items, query), [items, query])

  // 查询变化重置选中
  useEffect(() => { setActiveIdx(0) }, [query])

  // activeIdx 变化滚入可视区
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-palette-idx="${activeIdx}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIdx])

  const close = useCallback(() => setOpen(false), [])

  const execute = useCallback((item: PaletteItem) => {
    switch (item.type) {
      case 'conv-chat':
        requestOpenConversation({ conversationId: item.id, assistantId: item.assistantId, isAgent: false })
        break
      case 'conv-agent':
        requestOpenConversation({ conversationId: item.id, assistantId: item.assistantId, isAgent: true })
        break
      case 'assistant':
        requestOpenConversation({ assistantId: item.id, isAgent: false })
        break
      case 'kb':
        requestOpenKb(item.id)
        break
      case 'module':
        if (item.moduleId) useAppStore.getState().switchModule(item.moduleId as ModuleId)
        break
    }
    close()
  }, [close])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIdx((i) => nextPaletteIndex(i, filtered.length, 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIdx((i) => nextPaletteIndex(i, filtered.length, -1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = filtered[activeIdx]
      if (item) execute(item)
    }
  }

  if (!open) return null

  // 分组渲染：按 GROUPS 顺序输出非空组（组标题不占展平下标）
  let flatIdx = -1
  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center pt-[12vh] bg-black/40"
      onMouseDown={close}
      role="dialog"
      aria-modal="true"
      aria-label={t('palette.placeholder')}
    >
      <div
        className="w-[560px] max-w-[92vw] rounded-xl border border-[var(--color-border)] shadow-2xl overflow-hidden"
        style={{ background: 'var(--color-surface)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 border-b border-[var(--color-border)]">
          <span className="text-sm opacity-60">🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('palette.placeholder')}
            className="flex-1 bg-transparent outline-none py-2.5 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)]"
          />
          <kbd className="text-[10px] text-[var(--color-text-muted)] border border-[var(--color-border)] rounded px-1 py-0.5">Esc</kbd>
        </div>
        <div ref={listRef} className="max-h-[52vh] overflow-auto py-1">
          {loading && (
            <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">{t('palette.noResults')}</div>
          )}
          {!loading && GROUPS.map((g) => {
            const groupItems = filtered.filter((it) => it.type === g.type)
            if (groupItems.length === 0) return null
            return (
              <div key={g.type}>
                <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">
                  {g.icon} {t(g.labelKey)}
                </div>
                {groupItems.map((item) => {
                  flatIdx += 1
                  const idx = flatIdx
                  const active = idx === activeIdx
                  return (
                    <button
                      key={`${item.type}-${item.id}`}
                      data-palette-idx={idx}
                      type="button"
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => execute(item)}
                      className={`w-full text-left px-3 py-1.5 flex items-center gap-2 text-xs ${
                        active ? 'bg-[var(--color-accent)] bg-opacity-15' : ''
                      }`}
                    >
                      <span className="truncate text-[var(--color-text)]">{item.title}</span>
                      {item.subtitle && (
                        <span className="truncate ml-auto text-[10px] text-[var(--color-text-muted)] max-w-[55%]">
                          {item.subtitle}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
