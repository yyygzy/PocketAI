// 通用「模型来源（服务商）→ 具体型号」两级选择器（模型启用与两级选择方案 §4）
//
// 契约：
//  · 只列 enabled 的服务商；二级只列 enabledModelsOf(p)（启用集口径，禁止直接读 p.models）
//  · 选中值仍是 `providerId:model`，与 ChatTarget 完全兼容
//  · 不做模型系列品牌推导，不设「其他」兜底分组（定稿决策 4）
//  · 键盘：↑/↓ 在型号列表移动，←/→ 切来源，Enter 选中，Esc 先清搜索再关闭
//  · `up`：浮窗内面板向上展开；点击外部关闭，关闭后焦点回触发器
import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderRecord } from '../../../shared/types'
import { enabledModelsOf } from '../../../shared/provider-models'
import { useI18n } from '../i18n'

interface SourceRow {
  id: string
  name: string
  host?: string
  models: string[]
}

interface ModelRow {
  providerId: string
  model: string
  /** 跨来源展示时行内标注的来源名（搜索「全部来源」视图） */
  sourceName?: string
}

interface Props {
  providers: ProviderRecord[]
  /** 当前值 `providerId:model`（可为空串） */
  value: string
  disabled?: boolean
  onChange: (providerId: string, model: string) => void
  /** 面板向上展开（浮窗贴底时用） */
  up?: boolean
  /** 没有任何可选项时触发器的文案（空态三分由调用方算好传入） */
  emptyText?: string
}

/** 型号过长时中间截断、保留尾部版本号；完整值放 title（§4.3/§4.4） */
function truncateMiddle(s: string, max = 34): string {
  if (s.length <= max) return s
  const keep = max - 1
  const head = Math.ceil(keep * 0.6)
  const tail = keep - head
  return `${s.slice(0, head)}…${s.slice(-tail)}`
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

export const ModelPicker: React.FC<Props> = ({ providers, value, disabled, onChange, up, emptyText }) => {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeSourceId, setActiveSourceId] = useState<string | null>(null)
  const [viewAll, setViewAll] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const sep = value.indexOf(':')
  const curProviderId = sep > 0 ? value.slice(0, sep) : ''
  const curModel = sep > 0 ? value.slice(sep + 1) : ''

  // 一级来源：只列启用的服务商；同名补充 baseUrl 主机名以示区分（§4.2）
  const sources: SourceRow[] = useMemo(
    () =>
      providers
        .filter((p) => p.enabled)
        .map((p) => ({
          id: p.id,
          name: p.name,
          host:
            providers.filter((x) => x.enabled && x.name === p.name).length > 1
              ? hostOf(p.baseUrl)
              : undefined,
          models: enabledModelsOf(p)
        })),
    [providers]
  )

  // 当前值是否仍在启用集（不在则触发器标「不可用」，不静默换模型）
  const curSource = sources.find((s) => s.id === curProviderId)
  const curAvailable = !!curSource && curSource.models.includes(curModel)

  const q = query.trim().toLowerCase()
  // 搜索匹配「型号 + 来源名」（§4.5）：来源名命中 ⇒ 该来源全部模型都算命中
  const hitSources = useMemo(() => {
    if (!q) return []
    return sources
      .map((s) => {
        const modelHits = s.models.filter((m) => m.toLowerCase().includes(q))
        const nameHit = s.name.toLowerCase().includes(q)
        return { source: s, hits: nameHit ? s.models : modelHits }
      })
      .filter((e) => e.hits.length > 0)
  }, [sources, q])

  const totalHits = hitSources.reduce((n, e) => n + e.hits.length, 0)

  // 展示行：空查询=标准两级；有查询=当前来源命中或「全部来源」跨来源命中
  // （当前来源无命中时直接落到第一个命中的来源，避免右栏空白——§4.5）
  const rows: ModelRow[] = useMemo(() => {
    if (q) {
      if (viewAll) {
        return hitSources.flatMap((e) =>
          e.hits.map((m) => ({ providerId: e.source.id, model: m, sourceName: e.source.name }))
        )
      }
      const active = hitSources.find((e) => e.source.id === activeSourceId) ?? hitSources[0]
      return active ? active.hits.map((m) => ({ providerId: active.source.id, model: m })) : []
    }
    const active = sources.find((s) => s.id === activeSourceId)
    return active ? active.models.map((m) => ({ providerId: active.id, model: m })) : []
  }, [q, viewAll, hitSources, sources, activeSourceId])

  // 打开时定位：有当前值定位到它的来源与型号；没有则定位到第一个有启用模型的来源（§4.4）
  const openPanel = () => {
    if (disabled) return
    setOpen(true)
    setQuery('')
    setViewAll(false)
    setHighlight(-1)
    const initial =
      (curSource && curSource.models.length > 0 ? curSource.id : null) ??
      sources.find((s) => s.models.length > 0)?.id ??
      sources[0]?.id ??
      null
    setActiveSourceId(initial)
    // 等面板渲染后把当前型号滚进可视区（jsdom 无 scrollIntoView，可选调用）
    requestAnimationFrame(() => {
      searchRef.current?.focus()
      if (curSource?.id === initial && curModel) {
        listRef.current
          ?.querySelector(`[data-model="${CSS.escape(curProviderId + ':' + curModel)}"]`)
          ?.scrollIntoView?.({ block: 'nearest' })
      }
    })
  }

  const closePanel = (refocus = true) => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  const select = (row: ModelRow) => {
    onChange(row.providerId, row.model)
    closePanel()
  }

  // 点击外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) closePanel(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 有查询但当前来源无命中 → 自动切到第一个有命中的来源，避免右栏空白（§4.5）
  useEffect(() => {
    if (!q || viewAll) return
    if (hitSources.length === 0) return
    if (!hitSources.some((e) => e.source.id === activeSourceId)) {
      setActiveSourceId(hitSources[0]!.source.id)
    }
  }, [q, viewAll, hitSources, activeSourceId])

  useEffect(() => {
    if (highlight < 0) return
    const el = listRef.current?.querySelector(`[data-idx="${highlight}"]`)
    el?.scrollIntoView?.({ block: 'nearest' })
  }, [highlight])

  const onSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      if (q) {
        setQuery('')
        setViewAll(false)
      } else {
        closePanel()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, rows.length - 1))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[highlight] ?? (rows.length === 1 ? rows[0] : undefined)
      if (row) select(row)
      return
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      // ←/→ 在左栏来源间移动；「全部来源」也占一个位置（-1）
      const ids = hitSources.map((e) => e.source.id)
      if (ids.length === 0) return
      const allIdx = -1
      const cur = viewAll ? allIdx : ids.indexOf(activeSourceId ?? '')
      const step = e.key === 'ArrowRight' ? 1 : -1
      let next = cur + step
      if (next < allIdx) next = ids.length - 1
      if (next >= ids.length) next = allIdx
      if (next === allIdx) {
        setViewAll(true)
      } else {
        setViewAll(false)
        setActiveSourceId(ids[next]!)
      }
      setHighlight(-1)
    }
  }

  // 触发器文案（§4.4）：来源 · 型号短名；不可用时保留原值并标注
  let triggerLabel: React.ReactNode
  if (curProviderId && curModel) {
    const name = curSource?.name ?? curProviderId
    triggerLabel = (
      <span className="flex items-center gap-1 min-w-0">
        <span className="truncate">{name} · {truncateMiddle(curModel)}</span>
        {!curAvailable && (
          <span className="text-[10px] px-1 rounded bg-[var(--color-danger-bg)] text-[var(--color-danger)] shrink-0">
            {t('ms.pickerUnavailable')}
          </span>
        )}
      </span>
    )
  } else {
    triggerLabel = <span className="truncate">{emptyText}</span>
  }

  return (
    <div ref={rootRef} className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? closePanel() : openPanel())}
        className="select-mini min-w-[140px] max-w-[340px] text-left flex items-center justify-between gap-1 disabled:opacity-50"
        title={curSource && curModel ? `${curSource.name} / ${curModel}` : undefined}
      >
        {triggerLabel}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="shrink-0 opacity-60">
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div
          role="listbox"
          className={`absolute z-50 w-[440px] max-w-[90vw] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg ${
            up ? 'bottom-full mb-1' : 'top-full mt-1'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-2 border-b border-[var(--color-border)]">
            <input
              ref={searchRef}
              className="input text-xs py-1"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setHighlight(-1)
              }}
              onKeyDown={onSearchKeyDown}
              placeholder={t('ms.pickerSearchPh')}
            />
          </div>
          <div className="grid grid-cols-[140px_1fr]">
            {/* 一级：模型拉取来源（服务商） */}
            <div className="border-r border-[var(--color-border)] max-h-64 overflow-y-auto py-1">
              {q && (
                <button
                  type="button"
                  onClick={() => {
                    setViewAll(true)
                    setHighlight(-1)
                  }}
                  title={t('ms.pickerAllSources', { n: totalHits })}
                  className={`w-full text-left px-2 py-1 text-xs truncate ${
                    viewAll ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-hover-overlay)]'
                  }`}
                >
                  {t('ms.pickerAllSources', { n: totalHits })}
                </button>
              )}
              {sources.map((s) => {
                const empty = s.models.length === 0
                const active = !viewAll && s.id === activeSourceId
                const hits = q ? hitSources.find((e) => e.source.id === s.id)?.hits.length : undefined
                // 整句挂 truncate 必须 title 在场（§410 闸门）；title 与正文取同一键同一参数
                const n = q && hits != null ? hits : s.models.length
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setViewAll(false)
                      setActiveSourceId(s.id)
                      setHighlight(-1)
                    }}
                    title={s.host ? `${s.name}（${s.host}）` : s.name}
                    className={`w-full text-left px-2 py-1 text-xs ${
                      active ? 'bg-[var(--color-accent-soft)]' : 'hover:bg-[var(--color-hover-overlay)]'
                    } ${empty ? 'opacity-40' : ''}`}
                  >
                    <span className="block truncate" title={t('ms.pickerSourceCount', { name: s.name, n })}>
                      {t('ms.pickerSourceCount', { name: s.name, n })}
                    </span>
                    {empty && (
                      <span className="block text-[10px] text-[var(--color-text-muted)]" title={t('ms.pickerNoEnabled')}>
                        {t('ms.pickerNoEnabled')}
                      </span>
                    )}
                  </button>
                )
              })}
            </div>
            {/* 二级：该来源下的具体型号 */}
            <div ref={listRef} className="max-h-64 overflow-y-auto py-1">
              {q && hitSources.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[var(--color-text-muted)]">{t('ms.pickerNoMatch')}</p>
              ) : rows.length === 0 ? (
                <p className="px-3 py-2 text-xs text-[var(--color-text-muted)] leading-relaxed">
                  {t('ms.pickerGoSettings')}
                </p>
              ) : (
                rows.map((row, i) => {
                  const rowValue = `${row.providerId}:${row.model}`
                  const isCur = rowValue === value
                  return (
                    <button
                      key={rowValue}
                      type="button"
                      role="option"
                      aria-selected={isCur}
                      data-model={rowValue}
                      data-idx={i}
                      onClick={() => select(row)}
                      onMouseEnter={() => setHighlight(i)}
                      className={`w-full text-left px-3 py-1 text-xs font-mono flex items-center gap-2 ${
                        i === highlight ? 'bg-[var(--color-hover-overlay)]' : ''
                      } ${isCur ? 'text-[var(--color-accent)]' : ''}`}
                      title={row.model}
                    >
                      <span className="truncate flex-1">{truncateMiddle(row.model)}</span>
                      {row.sourceName && (
                        <span className="text-[10px] text-[var(--color-text-muted)] shrink-0">
                          {row.sourceName}
                        </span>
                      )}
                      {isCur && <span className="text-[10px] shrink-0">✓</span>}
                    </button>
                  )
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
