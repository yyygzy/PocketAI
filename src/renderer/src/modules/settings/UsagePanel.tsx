// 用量统计面板：token 用量汇总 + 按日趋势（纯 CSS 柱状图）+ provider/模型排行 + 费用估算
// 数据来源：messages.usage（chat/agent 生成完成时落库），IPC getUsageSummary 聚合
// 费用按本机配置的「每 100 万 token 单价」估算，单价仅存本地不上传
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelPrice, UsageConversationItem, UsageModelItem, UsagePricing, UsageSummary } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { errText } from '../../utils/error'
import { reportIpcError } from '../../utils/ipc'

/** token 数量级缩写：<1000 原样，≥1000 显示 k，≥1M 显示 M */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

/** 费用格式：≥1 两位小数，0<n<1 四位小数，0 → 空串（UI 显示 —） */
function fmtCost(n: number): string {
  if (!n || n <= 0) return ''
  if (n >= 1) return n.toFixed(2)
  return n.toFixed(4)
}

const RANGES = [7, 30, 90] as const

/** provider::model 价格表 key（与主进程 priceKey 同构） */
const pk = (provider: string, model: string) => `${provider}::${model}`

export const UsagePanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const [days, setDays] = useState<number>(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [convUsage, setConvUsage] = useState<UsageConversationItem[]>([])
  const [pricing, setPricing] = useState<UsagePricing | null>(null)
  const [showEditor, setShowEditor] = useState(false)

  const currencySymbol = pricing?.currency === 'USD' ? '$' : '¥'

  const load = useCallback((d: number) => {
    window.pocketai.getUsageSummary(d).then(setSummary).catch(reportIpcError('usage.get'))
    window.pocketai.getUsageConversations(d, 20).then(setConvUsage).catch(reportIpcError('usage.conversations'))
  }, [])

  useEffect(() => {
    load(days)
  }, [load, days])

  useEffect(() => {
    window.pocketai.getUsagePricing().then(setPricing).catch(reportIpcError('usage.pricingGet'))
  }, [])

  const reload = useCallback(() => load(days), [days, load])

  const maxDaily = summary ? Math.max(...summary.daily.map((d) => d.totalTokens), 1) : 1
  const maxProvider = summary && summary.byProvider.length > 0 ? summary.byProvider[0]!.totalTokens : 1

  return (
    <div>
      {/* 范围切换 */}
      <div className="flex gap-1.5 mb-3">
        {RANGES.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`chip ${days === d ? 'chip-accent' : ''}`}
          >
            {t(`usage.days${d}`)}
          </button>
        ))}
      </div>

      {!summary ? (
        <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
      ) : summary.totals.requests === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)] py-3">{t('usage.noData')}</div>
      ) : (
        <>
          {/* 汇总卡片 */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
            <StatCard label={t('usage.requests')} value={String(summary.totals.requests)} />
            <StatCard label={t('usage.totalTokens')} value={fmtTokens(summary.totals.totalTokens)} />
            <StatCard label={t('usage.prompt')} value={fmtTokens(summary.totals.promptTokens)} />
            <StatCard label={t('usage.completion')} value={fmtTokens(summary.totals.completionTokens)} />
            <StatCard
              label={t('usage.cost')}
              value={fmtCost(summary.totals.cost) ? `${currencySymbol}${fmtCost(summary.totals.cost)}` : '—'}
              hint={summary.totals.cost > 0 ? undefined : t('usage.costEmpty')}
            />
          </div>
          {summary.totals.cachedTokens > 0 && (
            <div className="text-[11px] text-[var(--color-text-muted)] mb-3">
              {t('usage.cached', { count: fmtTokens(summary.totals.cachedTokens) })}
            </div>
          )}

          {/* 按日趋势柱状图（纯 CSS，无图表库依赖） */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.daily')}</div>
          <div className="flex items-end gap-[2px] h-24 mb-3" role="img" aria-label={t('usage.daily')}>
            {summary.daily.map((d) => {
              const pct = Math.round((d.totalTokens / maxDaily) * 100)
              return (
                <div
                  key={d.date}
                  className="flex-1 min-w-[3px] rounded-t bg-[var(--color-accent)] opacity-80 hover:opacity-100"
                  style={{ height: `${Math.max(pct, d.totalTokens > 0 ? 3 : 1)}%` }}
                  title={`${d.date} · ${fmtTokens(d.totalTokens)}${d.cost > 0 ? ` · ${currencySymbol}${fmtCost(d.cost)}` : ''}`}
                />
              )
            })}
          </div>
          <div className="flex justify-between text-[10px] text-[var(--color-text-muted)] mb-4">
            <span>{summary.daily[0]?.date}</span>
            <span>{summary.daily[summary.daily.length - 1]?.date}</span>
          </div>

          {/* Provider 排行 */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.byProvider')}</div>
          <div className="flex flex-col gap-1.5 mb-4">
            {summary.byProvider.map((p) => (
              <div key={p.provider}>
                <div className="flex justify-between text-[11px] mb-0.5">
                  <span className="text-[var(--color-text)] truncate">{p.provider}</span>
                  <span className="text-[var(--color-text-muted)] shrink-0 ml-2">
                    {p.cost > 0 && <span className="mr-1.5 text-[var(--color-accent)]">{currencySymbol}{fmtCost(p.cost)}</span>}
                    {fmtTokens(p.totalTokens)} · {t('usage.requestCount', { count: p.requests })}
                  </span>
                </div>
                <div className="h-1.5 rounded bg-[var(--color-sidebar)] overflow-hidden">
                  <div
                    className="h-full rounded bg-[var(--color-accent)] opacity-80"
                    style={{ width: `${Math.max((p.totalTokens / maxProvider) * 100, 2)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          {/* 模型 Top10 */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.byModel')}</div>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--color-text-muted)]">
                <th className="py-1 pr-2 font-normal">{t('usage.model')}</th>
                <th className="py-1 pr-2 font-normal text-right">{t('usage.requests')}</th>
                <th className="py-1 pr-2 font-normal text-right">{t('usage.totalTokens')}</th>
                <th className="py-1 font-normal text-right">{t('usage.cost')}</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={`${m.provider}::${m.model}`} className="border-t border-[var(--color-border)]">
                  <td className="py-1.5 pr-2 truncate max-w-0">
                    <span className="text-[var(--color-text)]">{m.model}</span>
                    <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{m.provider}</span>
                  </td>
                  <td className="py-1.5 pr-2 text-right text-[var(--color-text-muted)]">{m.requests}</td>
                  <td className="py-1.5 pr-2 text-right font-mono text-[var(--color-text)]">{fmtTokens(m.totalTokens)}</td>
                  <td className="py-1.5 text-right font-mono text-[var(--color-accent)]">
                    {m.cost > 0 ? `${currencySymbol}${fmtCost(m.cost)}` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 会话排行（Top20，随天数范围联动） */}
          {convUsage.length > 0 && (
            <>
              <div className="mb-1 mt-4 text-xs font-semibold text-[var(--color-text)]">{t('usage.byConversation')}</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--color-text-muted)]">
                    <th className="py-1 pr-2 font-normal">{t('usage.conversation')}</th>
                    <th className="py-1 pr-2 font-normal text-right">{t('usage.requests')}</th>
                    <th className="py-1 pr-2 font-normal text-right">{t('usage.totalTokens')}</th>
                    <th className="py-1 font-normal text-right">{t('usage.cost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {convUsage.map((c) => (
                    <tr key={c.conversationId} className="border-t border-[var(--color-border)]">
                      <td className="py-1.5 pr-2 truncate max-w-0">
                        <span className="text-[var(--color-text)]" title={c.title}>{c.title}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[var(--color-text-muted)]">{c.requests}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[var(--color-text)]">{fmtTokens(c.totalTokens)}</td>
                      <td className="py-1.5 text-right font-mono text-[var(--color-accent)]">
                        {c.cost > 0 ? `${currencySymbol}${fmtCost(c.cost)}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}

      {/* 单价设置 */}
      {pricing && (
        <div className="mt-4 border-t border-[var(--color-border)] pt-3">
          <button
            type="button"
            onClick={() => setShowEditor((v) => !v)}
            className="text-xs font-semibold text-[var(--color-text)] hover:text-[var(--color-accent)] transition-colors"
          >
            {showEditor ? '▼' : '▶'} {t('usage.priceSettings')}
          </button>
          {showEditor && (
            <PriceEditor
              pricing={pricing}
              onSaved={(next) => {
                setPricing(next)
                reload()
                toast.success(t('usage.priceSaved'))
              }}
              onError={(e) => toast.error(t('common.opFailed', { msg: errText(e) }))}
            />
          )}
        </div>
      )}
    </div>
  )
}

/** 单价编辑器：币种切换 + 每个历史模型 输入/缓存/输出 三个单价（每 100 万 token） */
const PriceEditor: React.FC<{
  pricing: UsagePricing
  onSaved: (next: UsagePricing) => void
  onError: (e: unknown) => void
}> = ({ pricing, onSaved, onError }) => {
  const { t } = useI18n()
  const [models, setModels] = useState<UsageModelItem[] | null>(null)
  const [currency, setCurrency] = useState<UsagePricing['currency']>(pricing.currency)
  const [drafts, setDrafts] = useState<Record<string, { input: string; cache: string; output: string }>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    window.pocketai.listUsageModels()
      .then(setModels)
      .catch((e) => onError(e))
  }, [onError])

  // 编辑行清单：历史模型（按最近使用）∪ 已配置但已无用量的 key，去重
  const rows = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; provider: string; model: string }[] = []
    for (const m of models ?? []) {
      const key = pk(m.provider, m.model)
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ key, provider: m.provider, model: m.model })
    }
    for (const key of Object.keys(pricing.prices)) {
      if (seen.has(key)) continue
      const idx = key.indexOf('::')
      if (idx < 0) continue
      seen.add(key)
      out.push({ key, provider: key.slice(0, idx), model: key.slice(idx + 2) })
    }
    return out
  }, [models, pricing.prices])

  const draftOf = (key: string) => {
    const cached = drafts[key]
    if (cached) return cached
    const p = pricing.prices[key]
    return {
      input: p ? String(p.input) : '',
      cache: p?.cache !== undefined ? String(p.cache) : '',
      output: p ? String(p.output) : ''
    }
  }

  const setField = (key: string, field: 'input' | 'cache' | 'output', value: string) => {
    setDrafts((prev) => ({ ...prev, [key]: { ...draftOf(key), ...prev[key], [field]: value } }))
  }

  /** 解析输入框：空=该字段不设置；非法数字返回错误信息 */
  const parseNum = (s: string): number | null | string => {
    const v = s.trim()
    if (!v) return null
    const n = Number(v)
    if (!Number.isFinite(n) || n < 0) return t('usage.priceInvalid')
    return n
  }

  const save = async () => {
    const prices: Record<string, ModelPrice> = {}
    for (const row of rows) {
      const d = draftOf(row.key)
      const input = parseNum(d.input)
      const output = parseNum(d.output)
      const cache = parseNum(d.cache)
      if (typeof input === 'string' || typeof output === 'string' || typeof cache === 'string') {
        onError(new Error(`${row.model}: ${t('usage.priceInvalid')}`))
        return
      }
      // input/output 成对配置才算该模型有价（只填一个忽略，避免半套单价）
      if (input === null || output === null) {
        if (input !== null || output !== null || cache !== null) {
          onError(new Error(`${row.model}: ${t('usage.priceNeedPair')}`))
          return
        }
        continue
      }
      const p: ModelPrice = { input, output }
      if (cache !== null) p.cache = cache
      prices[row.key] = p
    }
    setSaving(true)
    try {
      const next = await window.pocketai.setUsagePricing({ currency, prices })
      setDrafts({})
      onSaved(next)
    } catch (e) {
      onError(e)
    } finally {
      setSaving(false)
    }
  }

  const fieldCls =
    'w-16 px-1.5 py-1 text-[11px] font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]'

  return (
    <div className="mt-2">
      {/* 币种切换 */}
      <div className="flex items-center gap-1.5 mb-2">
        {(['CNY', 'USD'] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCurrency(c)}
            className={`chip ${currency === c ? 'chip-accent' : ''}`}
          >
            {c === 'CNY' ? '¥ CNY' : '$ USD'}
          </button>
        ))}
      </div>

      <div className="rounded-lg border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-left text-[var(--color-text-muted)] bg-[var(--color-sidebar)]">
              <th className="py-1.5 px-2 font-normal">{t('usage.model')}</th>
              <th className="py-1.5 px-1 font-normal text-right w-[72px]">{t('usage.priceInput')}</th>
              <th className="py-1.5 px-1 font-normal text-right w-[72px]">{t('usage.priceCache')}</th>
              <th className="py-1.5 px-2 font-normal text-right w-[72px]">{t('usage.priceOutput')}</th>
            </tr>
          </thead>
          <tbody>
            {models === null ? (
              <tr><td colSpan={4} className="py-3 px-2 text-[var(--color-text-muted)]">{t('common.loading')}</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={4} className="py-3 px-2 text-[var(--color-text-muted)]">{t('usage.priceNoModels')}</td></tr>
            ) : (
              rows.map((row) => {
                const d = draftOf(row.key)
                return (
                  <tr key={row.key} className="border-t border-[var(--color-border)]">
                    <td className="py-1 px-2 truncate max-w-0">
                      <span className="text-[var(--color-text)]">{row.model}</span>
                      <span className="text-[10px] text-[var(--color-text-muted)] ml-1.5">{row.provider}</span>
                    </td>
                    <td className="py-1 px-1 text-right">
                      <input className={fieldCls} inputMode="decimal" value={d.input} placeholder="—"
                        onChange={(e) => setField(row.key, 'input', e.target.value)} />
                    </td>
                    <td className="py-1 px-1 text-right">
                      <input className={fieldCls} inputMode="decimal" value={d.cache} placeholder="—"
                        onChange={(e) => setField(row.key, 'cache', e.target.value)} />
                    </td>
                    <td className="py-1 px-2 text-right">
                      <input className={fieldCls} inputMode="decimal" value={d.output} placeholder="—"
                        onChange={(e) => setField(row.key, 'output', e.target.value)} />
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-2 flex items-center gap-2">
        <button type="button" disabled={saving || models === null} onClick={() => void save()} className="chip chip-accent">
          {t('usage.priceSave')}
        </button>
      </div>
      <ul className="mt-2 text-[10px] leading-relaxed text-[var(--color-text-muted)] list-disc pl-4 space-y-0.5">
        <li>{t('usage.priceHintUnit')}</li>
        <li>{t('usage.priceHintCache')}</li>
        <li>{t('usage.priceHintLocal')}</li>
      </ul>
    </div>
  )
}

const StatCard: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-base font-semibold font-mono text-[var(--color-text)] mt-0.5" title={hint}>{value}</div>
  </div>
)
