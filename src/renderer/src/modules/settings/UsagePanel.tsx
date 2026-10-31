// 用量统计面板：token 用量汇总 + 按日趋势（纯 CSS 柱状图）+ provider/模型/会话/助手排行 + 费用估算
// 数据来源：messages.usage（chat/agent 生成完成时落库），IPC getUsageSummary 聚合
// 费用按本机配置的「每 100 万 token 单价」估算，单价仅存本地不上传
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelPrice, UsageAssistantItem, UsageBudgetStatus, UsageConversationItem, UsageDetailItem, UsageModelItem, UsagePricing, UsageSummary } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { builtinAssistantNameById } from '../chat/assistant-display'
import { useToast } from '../../components/ToastProvider'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { StaleValueNotice } from '../../components/StaleValueNotice'
import { errText } from '../../utils/error'
import { reportIpcError, hasIpcFailed, ipcFailText } from '../../utils/ipc'
import { requestUsageJump } from './usage-jump'
import { fmtTokens, fmtCost } from '../../utils/token'
import { buildUsageCsv } from '../../utils/usage-csv'
import { priceKey } from '../../../../shared/usage-pricing'

const RANGES = [7, 30, 90] as const
/** 导出行级明细的上限（与主进程 listUsageDetail 默认值一致；超出会提示截断） */
const EXPORT_LIMIT = 10000

export const UsagePanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  /**
   * §221：`.then(...)` 面上的失败是 resolve 出来的 `{ok:false}`——写进 state 就是"把失败对象当数据"，
   * 读它的那句解构／`.map` 当场崩。这里沿用闸门认识的 `failAction` 形状：说出来，并交回"这次没读到"。
   * §222 多加一件事：@param inline 只有汇总那一读会传——它决定整张面板是「加载中…」还是有内容，
   * 光一条会消失的 toast 等于把"读不到"长期谎称成"还在加载"，所以原因同时留一份给常驻那句。
   */
  const failAction = (r: unknown, inline?: (msg: string) => void): boolean => {
    if (!hasIpcFailed(r)) return false
    const msg = ipcFailText(r, t('common.unknownError'))
    toast.error(t('common.opFailed', { msg }))
    if (inline) inline(msg)
    return true
  }
  const [days, setDays] = useState<number>(30)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  // §222：汇总那一读的失败原因（null=没失败过）——它决定本体显示「读不到：原因」还是「加载中…」
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [convUsage, setConvUsage] = useState<UsageConversationItem[]>([])
  const [asstUsage, setAsstUsage] = useState<UsageAssistantItem[]>([])
  const [pricing, setPricing] = useState<UsagePricing | null>(null)
  const [showEditor, setShowEditor] = useState(false)
  const [exporting, setExporting] = useState(false)
  // 逐轮明细弹窗（会话/助手两个维度共用；showConv 控制是否显示「会话」列）
  const [detail, setDetail] = useState<{ title: string; showConv: boolean } | null>(null)
  const [detailItems, setDetailItems] = useState<UsageDetailItem[]>([])
  const [detailLoading, setDetailLoading] = useState(false)
  // §376：producer（listUsageDetail）在行数超上限时如实回 truncated=true；footer 的合计只覆盖
  // 已展示的那部分，不接这个 flag 就会被读成「这一窗全量」⇒对话框每次开都要重置、成功才写
  const [detailTruncated, setDetailTruncated] = useState(false)
  // 预算提醒：daily/monthly 上限（null=不限）+ 今日/本月已花估算
  const [budget, setBudget] = useState<UsageBudgetStatus | null>(null)
  const [budgetEditing, setBudgetEditing] = useState(false)
  const [budgetDailyDraft, setBudgetDailyDraft] = useState('')
  const [budgetMonthlyDraft, setBudgetMonthlyDraft] = useState('')
  const [budgetHardBlockDraft, setBudgetHardBlockDraft] = useState(false)
  const [budgetWarnDraft, setBudgetWarnDraft] = useState(true)
  const [budgetSaving, setBudgetSaving] = useState(false)

  const openDetail = useCallback(async (id: string, title: string) => {
    setDetail({ title, showConv: false })
    setDetailLoading(true)
    setDetailItems([])
    setDetailTruncated(false)
    try {
      const r = await window.pocketai.getUsageDetail(days, EXPORT_LIMIT, id)
      // safeHandle 的失败是 resolve 的 {ok:false}：不判就 setDetailItems(对象.items=undefined) ⇒ 550 行 .map 崩
      if (hasIpcFailed(r)) toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
      else {
        setDetailItems(r.items)
        setDetailTruncated(r.truncated)
      }
    } catch (e) {
      reportIpcError('usage.detail')(e)
    } finally {
      setDetailLoading(false)
    }
  }, [days])

  // 助手维度明细：assistantId 为 null 表示自由会话（排行里聚合为「(未知助手)」）
  const openAsstDetail = useCallback(async (assistantId: string | null, name: string) => {
    setDetail({ title: name, showConv: true })
    setDetailLoading(true)
    setDetailItems([])
    setDetailTruncated(false)
    try {
      const r = await window.pocketai.getUsageDetail(days, EXPORT_LIMIT, undefined, assistantId)
      // safeHandle 的失败是 resolve 的 {ok:false}：不判就 setDetailItems(对象.items=undefined) ⇒ 550 行 .map 崩
      if (hasIpcFailed(r)) toast.error(t('common.opFailed', { msg: ipcFailText(r, t('common.unknownError')) }))
      else {
        setDetailItems(r.items)
        setDetailTruncated(r.truncated)
      }
    } catch (e) {
      reportIpcError('usage.detail')(e)
    } finally {
      setDetailLoading(false)
    }
  }, [days])

  const currencySymbol = pricing?.currency === 'USD' ? '$' : '¥'

  const load = useCallback((d: number) => {
    window.pocketai.getUsageSummary(d).then((r) => {
      if (failAction(r, setLoadErr)) return
      // §345：新值一到，「下面显示的是上一次读到的值」当场不再成立 ⇒ 成功侧必须把原因收回
      setLoadErr(null)
      setSummary(r)
    // §345：reject 面（桥层抛出，不走 safeHandle 的 {ok:false}）以前只进 console ⇒
    // 屏上照旧摆着上一窗的汇总、一个字都没说，与本批其余六处同口径写进同一份 err
    }).catch((e: unknown) => {
      setLoadErr(errText(e, t('common.unknownError')))
      reportIpcError('usage.get')(e)
    })
    window.pocketai.getUsageConversations(d, 20).then((r) => { if (!failAction(r)) setConvUsage(r) }).catch(reportIpcError('usage.conversations'))
    window.pocketai.getUsageAssistants(d, 10).then((r) => { if (!failAction(r)) setAsstUsage(r) }).catch(reportIpcError('usage.assistants'))
    // deps 与文件里 openDetail 那两条同口径（toast/t 只用于报错，不必进依赖）
  }, [])

  useEffect(() => {
    load(days)
  }, [load, days])

  useEffect(() => {
    window.pocketai.getUsagePricing().then((r) => { if (!failAction(r)) setPricing(r) }).catch(reportIpcError('usage.pricingGet'))
  }, [])

  useEffect(() => {
    window.pocketai.getUsageBudget().then((r) => { if (!failAction(r)) setBudget(r) }).catch(reportIpcError('usage.budgetGet'))
  }, [])

  /** 保存预算：空=不限制（存 null）；非法数字拦截 */
  const saveBudget = useCallback(async () => {
    const parse = (s: string): number | null | 'invalid' => {
      const v = s.trim()
      if (!v) return null
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? n : 'invalid'
    }
    const daily = parse(budgetDailyDraft)
    const monthly = parse(budgetMonthlyDraft)
    if (daily === 'invalid' || monthly === 'invalid') {
      toast.error(t('usage.priceInvalid'))
      return
    }
    setBudgetSaving(true)
    try {
      const next = await window.pocketai.setUsageBudget(daily, monthly, budgetHardBlockDraft, budgetWarnDraft)
      // 失败 ⇒ 不写 budget、不关编辑态（§214：今天会把 limit/cost 显示成「未设置」并报「已保存」）
      if (hasIpcFailed(next)) {
        toast.error(t('common.opFailed', { msg: ipcFailText(next, t('common.unknownError')) }))
        return
      }
      setBudget(next)
      setBudgetEditing(false)
      toast.success(t('usage.budgetSaved'))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    } finally {
      setBudgetSaving(false)
    }
  }, [budgetDailyDraft, budgetMonthlyDraft, budgetHardBlockDraft, budgetWarnDraft, t, toast])

  const reload = useCallback(() => load(days), [days, load])

  /** 导出当前时间范围的行级明细 CSV（每轮生成一行，可丢进表格透视/报销） */
  const handleExportCsv = useCallback(async () => {
    if (exporting) return
    setExporting(true)
    try {
      const { items, truncated } = await window.pocketai.getUsageDetail(days, EXPORT_LIMIT)
      if (items.length === 0) return
      const csv = buildUsageCsv(items, {
        time: t('usage.colTime'),
        conversation: t('usage.conversation'),
        assistant: t('usage.assistant'),
        provider: t('usage.colProvider'),
        model: t('usage.model'),
        prompt: t('usage.prompt'),
        completion: t('usage.completion'),
        cached: t('usage.colCached'),
        total: t('usage.totalTokens'),
        cost: t('usage.cost')
      })
      const r = await window.pocketai.exportUsageCsv({ days, content: csv })
      if (!r.ok) {
        toast.error(t('common.opFailed', { msg: r.error ?? '' }))
        return
      }
      if (r.canceled) return
      toast.success(t('usage.exportCsvDone', { count: items.length }))
      if (truncated) toast.warning(t('usage.exportCsvTruncated', { limit: EXPORT_LIMIT }))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    } finally {
      setExporting(false)
    }
  }, [days, exporting, t, toast])

  const maxDaily = summary ? Math.max(...summary.daily.map((d) => d.totalTokens), 1) : 1
  const maxDailyCost = summary ? Math.max(...summary.daily.map((d) => d.cost), 0) : 0
  const hasData = !!summary && summary.totals.requests > 0

  return (
    <div>
      {/* 范围切换 */}
      <div className="flex items-center gap-1.5 mb-3">
        {RANGES.map((d) => (
          <button
            key={d}
            onClick={() => setDays(d)}
            className={`chip ${days === d ? 'chip-accent' : ''}`}
          >
            {t(`usage.days${d}`)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => void handleExportCsv()}
          disabled={!hasData || exporting}
          className="chip ml-auto"
          title={hasData ? undefined : t('usage.noData')}
        >
          {exporting ? '⏳' : '⬇️'} {t('usage.exportCsv')}
        </button>
      </div>

      {/* 预算提醒：每日/每月进度条，超支红字；未配置时显示「未设置」由 ⚙️ 进入编辑 */}
      {budget && (
        <div className="mb-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
          <div className="flex items-center mb-1.5">
            <span className="text-xs font-semibold text-[var(--color-text)]">{t('usage.budget')}</span>
            <button
              type="button"
              className="ml-auto text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
              onClick={() => {
                if (!budgetEditing) {
                  setBudgetDailyDraft(budget.daily !== null ? String(budget.daily) : '')
                  setBudgetMonthlyDraft(budget.monthly !== null ? String(budget.monthly) : '')
                  setBudgetHardBlockDraft(budget.hardBlock)
                  setBudgetWarnDraft(budget.warn)
                }
                setBudgetEditing((v) => !v)
              }}
            >
              {budgetEditing ? t('common.cancel') : `⚙️ ${t('usage.budget')}`}
            </button>
          </div>
          <BudgetRow label={t('usage.budgetDaily')} limit={budget.daily} cost={budget.todayCost} symbol={currencySymbol} overText={t('usage.budgetExceeded', { scope: t('usage.budgetDaily') })} />
          <BudgetRow label={t('usage.budgetMonthly')} limit={budget.monthly} cost={budget.monthCost} symbol={currencySymbol} overText={t('usage.budgetExceeded', { scope: t('usage.budgetMonthly') })} />
          {!budgetEditing && (
            <div className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              {budget.warn ? t('usage.budgetWarnStateOn') : t('usage.budgetWarnStateOff')}
            </div>
          )}
          {budgetEditing && (
            <>
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              <span className="text-[var(--color-text-muted)] shrink-0">{t('usage.budgetDaily')}</span>
              <input
                className="w-20 px-1.5 py-1 font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                inputMode="decimal"
                placeholder="—"
                value={budgetDailyDraft}
                onChange={(e) => setBudgetDailyDraft(e.target.value)}
              />
              <span className="text-[var(--color-text-muted)] shrink-0 ml-2">{t('usage.budgetMonthly')}</span>
              <input
                className="w-20 px-1.5 py-1 font-mono rounded border border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
                inputMode="decimal"
                placeholder="—"
                value={budgetMonthlyDraft}
                onChange={(e) => setBudgetMonthlyDraft(e.target.value)}
              />
              <button type="button" disabled={budgetSaving} onClick={() => void saveBudget()} className="chip chip-accent ml-auto">
                {t('usage.budgetSave')}
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={budgetHardBlockDraft}
                onChange={(e) => setBudgetHardBlockDraft(e.target.checked)}
                className="cursor-pointer"
              />
              <span>{t('usage.budgetHardBlock')}</span>
            </label>
            <label className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] cursor-pointer select-none">
              <input
                type="checkbox"
                checked={budgetWarnDraft}
                onChange={(e) => setBudgetWarnDraft(e.target.checked)}
                className="cursor-pointer"
              />
              <span>{t('usage.budgetWarn')}</span>
            </label>
            </>
          )}
        </div>
      )}

      {/* §345：`load(days)` 会随时间窗切换重跑（7／30／90 天三档），失败侧留着上一窗的汇总是对的，
          但那一屏卡片是按"当前所选天数"摆的——切到 30 天失败后屏上还是 7 天的数字却不说明，就是拿旧数当新数 */}
      {summary && loadErr && (
        <div className="mb-2">
          <StaleValueNotice what={t('set.usage')} msg={loadErr} onRetry={reload} testid="usage-summary-stale-retry" />
        </div>
      )}
      {!summary ? (
        loadErr ? (
          // §350：首读失败时 §345 那颗横幅键（`summary &&`）不在屏上，同屏唯一的再触器是日窗 chips
          // ——那是"换个窗口顺带重读"，不是"重读这一发"。补同级一颗，走 `reload`（同一发 `load(days)`）。
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <LoadFailNotice msg={loadErr} />
            <button
              data-testid="usage-summary-read-retry"
              className="text-xs underline text-[var(--color-text-muted)]"
              onClick={reload}
            >
              {t('agent.retryRead')}
            </button>
          </div>
        ) : (
          <div className="text-xs text-[var(--color-text-muted)] py-3">{t('common.loading')}</div>
        )
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

          {/* 费用趋势柱状图（有费用数据时展示） */}
          {maxDailyCost > 0 && (
            <>
              <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.costTrend')}</div>
              <div className="flex items-end gap-[2px] h-20 mb-3" role="img" aria-label={t('usage.costTrend')}>
                {summary.daily.map((d) => {
                  const pct = Math.round((d.cost / maxDailyCost) * 100)
                  return (
                    <div
                      key={d.date}
                      className="flex-1 min-w-[3px] rounded-t bg-[var(--color-accent)] opacity-70 hover:opacity-100"
                      style={{ height: `${Math.max(pct, d.cost > 0 ? 3 : 1)}%` }}
                      title={`${d.date} · ${currencySymbol}${fmtCost(d.cost)}`}
                    />
                  )
                })}
              </div>
              <div className="flex justify-between text-[10px] text-[var(--color-text-muted)] mb-4">
                <span>{summary.daily[0]?.date}</span>
                <span>{summary.daily[summary.daily.length - 1]?.date}</span>
              </div>
            </>
          )}

          {/* 按 Provider：环形图 + 列表 */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.byProvider')}</div>
          <div className="flex gap-4 mb-4 items-start">
            {/* 纯 CSS 环形图（conic-gradient） */}
            <ProviderPie providers={summary.byProvider} />
            <div className="flex-1 flex flex-col gap-1.5">
              {summary.byProvider.map((p, idx) => (
                <div key={p.provider} className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: PROVIDER_COLORS[idx % PROVIDER_COLORS.length] }}
                  />
                  <span className="text-[11px] text-[var(--color-text)] truncate flex-1">{p.provider}</span>
                  <span className="text-[11px] text-[var(--color-text-muted)] shrink-0">
                    {p.cost > 0 && <span className="mr-1.5 text-[var(--color-accent)]">{currencySymbol}{fmtCost(p.cost)}</span>}
                    {fmtTokens(p.totalTokens)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* 模型 Top10：水平条形图 + 表格 */}
          <div className="mb-1 text-xs font-semibold text-[var(--color-text)]">{t('usage.byModel')}</div>
          <div className="flex flex-col gap-1.5 mb-4">
            {summary.byModel.map((m) => {
              // §358：分母是这张表里最大的那一项——整屏都没有用量时它自己也是 0，`0/0` 是 NaN，
              // `Math.max(NaN, 2)` 还是 NaN；而 `width: NaN%` 会被 Chromium 整条丢掉声明，条子回落到占满轨道
              // （真机量：600px 的轨道算得 600px）＝把"这家一点没用过"画成"这家用得最多"。零用量就画零。
              const maxModelTokens = summary.byModel[0]?.totalTokens ?? 0
              const pct = maxModelTokens > 0 ? Math.max((m.totalTokens / maxModelTokens) * 100, 2) : 0
              return (
                <div key={`${m.provider}::${m.model}`} className="flex items-center gap-2">
                  <span className="w-24 text-[11px] text-[var(--color-text)] truncate shrink-0" title={`${m.provider}/${m.model}`}>
                    {m.model}
                  </span>
                  <div className="flex-1 h-4 rounded bg-[var(--color-sidebar)] overflow-hidden">
                    <div
                      className="h-full rounded bg-[var(--color-accent)] opacity-80"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-20 text-[11px] text-right text-[var(--color-text-muted)] shrink-0">
                    {fmtTokens(m.totalTokens)}
                  </span>
                  <span className="w-16 text-[11px] text-right text-[var(--color-accent)] shrink-0">
                    {m.cost > 0 ? `${currencySymbol}${fmtCost(m.cost)}` : '—'}
                  </span>
                </div>
              )
            })}
          </div>

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
                    <th className="py-1 pr-2 font-normal text-right">{t('usage.cost')}</th>
                    <th className="py-1 font-normal text-right">{t('usage.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {convUsage.map((c) => (
                    <tr
                      key={c.conversationId}
                      className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-hover-overlay)]"
                      onClick={() => requestUsageJump({ type: 'conversation', convId: c.conversationId })}
                      title={t('usage.clickToJump')}
                    >
                      <td className="py-1.5 pr-2 truncate max-w-0">
                        <span className="text-[var(--color-text)]">{c.title}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[var(--color-text-muted)]">{c.requests}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[var(--color-text)]">{fmtTokens(c.totalTokens)}</td>
                      <td className="py-1.5 text-right font-mono text-[var(--color-accent)]">
                        {c.cost > 0 ? `${currencySymbol}${fmtCost(c.cost)}` : '—'}
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            openDetail(c.conversationId, c.title)
                          }}
                          className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                          title={t('usage.viewDetail')}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {/* 助手排行（Top10，随天数范围联动） */}
          {asstUsage.length > 0 && (
            <>
              <div className="mb-1 mt-4 text-xs font-semibold text-[var(--color-text)]">{t('usage.byAssistant')}</div>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-[var(--color-text-muted)]">
                    <th className="py-1 pr-2 font-normal">{t('usage.assistant')}</th>
                    <th className="py-1 pr-2 font-normal text-right">{t('usage.requests')}</th>
                    <th className="py-1 pr-2 font-normal text-right">{t('usage.totalTokens')}</th>
                    <th className="py-1 pr-2 font-normal text-right">{t('usage.cost')}</th>
                    <th className="py-1 font-normal text-right">{t('usage.detail')}</th>
                  </tr>
                </thead>
                <tbody>
                  {asstUsage.map((a) => (
                    <tr
                      key={a.assistantId}
                      className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-hover-overlay)]"
                      onClick={() => requestUsageJump({ type: 'assistant', assistantId: a.assistantId })}
                      title={t('usage.clickToJump')}
                    >
                      <td className="py-1.5 pr-2 truncate max-w-0">
                        <span className="text-[var(--color-text)]">{builtinAssistantNameById(a.assistantId, t) ?? a.name}</span>
                      </td>
                      <td className="py-1.5 pr-2 text-right text-[var(--color-text-muted)]">{a.requests}</td>
                      <td className="py-1.5 pr-2 text-right font-mono text-[var(--color-text)]">{fmtTokens(a.totalTokens)}</td>
                      <td className="py-1.5 text-right font-mono text-[var(--color-accent)]">
                        {a.cost > 0 ? `${currencySymbol}${fmtCost(a.cost)}` : '—'}
                      </td>
                      <td className="py-1.5 text-right">
                        <button
                          onClick={(e) => {
                            e.stopPropagation()
                            // 聚合 key 为 '(未知助手)' 的行对应 assistant_id 为 NULL 的自由会话
                            openAsstDetail(a.assistantId === '(未知助手)' ? null : a.assistantId, builtinAssistantNameById(a.assistantId, t) ?? a.name)
                          }}
                          className="text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                          title={t('usage.viewDetail')}
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                            <circle cx="12" cy="12" r="3" />
                          </svg>
                        </button>
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

      {/* 逐轮用量明细弹窗（会话/助手维度共用；助手维度多一列「会话」） */}
      {detail && (
        <div
          className="fixed inset-0 z-[9998] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm p-4"
          onClick={() => setDetail(null)}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border)]">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-[var(--color-text)] truncate">{detail.title}</div>
                <div className="text-[11px] text-[var(--color-text-muted)]">{t('usage.detailSubtitle', { days })}</div>
              </div>
              <button
                onClick={() => setDetail(null)}
                className="ml-auto p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-sidebar)]"
                title={t('common.close')}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {detailLoading ? (
                <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">{t('common.loading')}</div>
              ) : detailItems.length === 0 ? (
                <div className="p-8 text-center text-sm text-[var(--color-text-muted)]">{t('usage.detailEmpty')}</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-[var(--color-surface)]">
                    <tr className="text-left text-[var(--color-text-muted)]">
                      <th className="py-2 px-3 font-normal">{t('usage.detailTime')}</th>
                      {detail.showConv && <th className="py-2 px-3 font-normal">{t('usage.conversation')}</th>}
                      <th className="py-2 px-3 font-normal">{t('usage.detailModel')}</th>
                      <th className="py-2 px-3 font-normal text-right">{t('usage.detailIn')}</th>
                      <th className="py-2 px-3 font-normal text-right">{t('usage.detailOut')}</th>
                      <th className="py-2 px-3 font-normal text-right">{t('usage.detailCached')}</th>
                      <th className="py-2 px-3 font-normal text-right">{t('usage.detailTotal')}</th>
                      <th className="py-2 px-3 font-normal text-right">{t('usage.cost')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailItems.map((m) => (
                      <tr
                        key={m.messageId}
                        className="border-t border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-hover-overlay)]"
                        onClick={() => requestUsageJump({ type: 'conversation', convId: m.conversationId, messageId: m.messageId })}
                        title={t('usage.detailJumpHint')}
                      >
                        <td className="py-1.5 px-3 text-[var(--color-text-muted)] whitespace-nowrap">
                          {new Date(m.createdAt).toLocaleString()}
                        </td>
                        {detail.showConv && (
                          <td className="py-1.5 px-3 text-[var(--color-text)] truncate max-w-[120px]" title={m.conversationTitle}>
                            {m.conversationTitle}
                          </td>
                        )}
                        <td className="py-1.5 px-3 text-[var(--color-text)] truncate max-w-[140px]" title={`${m.provider}/${m.model}`}>
                          {m.model}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono text-[var(--color-text)]">{m.promptTokens.toLocaleString()}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[var(--color-text)]">{m.completionTokens.toLocaleString()}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[var(--color-text-muted)]">{m.cachedTokens.toLocaleString()}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[var(--color-text)]">{m.totalTokens.toLocaleString()}</td>
                        <td className="py-1.5 px-3 text-right font-mono text-[var(--color-accent)]">
                          {m.cost > 0 ? `${currencySymbol}${fmtCost(m.cost)}` : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    {detailTruncated && (
                      <tr>
                        <td
                          className="py-1 px-3 text-[11px] text-[var(--color-text-muted)]"
                          colSpan={detail.showConv ? 8 : 7}
                        >
                          {t('usage.detailTruncated', { limit: EXPORT_LIMIT })}
                        </td>
                      </tr>
                    )}
                    <tr className="border-t border-[var(--color-border)] font-semibold">
                      <td className="py-2 px-3 text-[var(--color-text)]" colSpan={detail.showConv ? 3 : 2}>{t('usage.detailTotal')}</td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--color-text)]">
                        {detailItems.reduce((s, m) => s + m.promptTokens, 0).toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--color-text)]">
                        {detailItems.reduce((s, m) => s + m.completionTokens, 0).toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--color-text-muted)]">
                        {detailItems.reduce((s, m) => s + m.cachedTokens, 0).toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--color-text)]">
                        {detailItems.reduce((s, m) => s + m.totalTokens, 0).toLocaleString()}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-[var(--color-accent)]">
                        {currencySymbol}{fmtCost(detailItems.reduce((s, m) => s + m.cost, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              )}
            </div>
          </div>
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
  // §222：与汇总那一读同一口径——表格里那一格也不许把"读不到"长期写成「加载中…」
  const [modelsErr, setModelsErr] = useState<string | null>(null)
  const [currency, setCurrency] = useState<UsagePricing['currency']>(pricing.currency)
  const [drafts, setDrafts] = useState<Record<string, { input: string; cache: string; output: string }>>({})
  const [saving, setSaving] = useState(false)

  // §347：这一发改前挂在 `deps=[onError]` 上、而调用点 :548 传的是**行内箭头**⇒父页每渲染一次
  // 就多读一发（§322"逐渲染重读"那一族：清单本身没变，那一发 IPC 却跟着界面重跑）。
  // 收成稳定的一份：`t`／`onError` 走 ref 现读，effect 依赖只剩"挂载这一次"。
  //
  // 同批更正 §345 记在这一格的两条（都是回读出来的，不是顺手改口径）：
  //  · **这里不挂旧值横幅**：那一发只有这一个读者——清单已经在屏上时，再没有第二个写者能把 `modelsErr` 写起来
  //    （收起再展开是重新挂载，state 从零开始）。§345 判它"有牙"靠的正是那条逐渲染重读；
  //    重读收干之后就没有"停在上一份"这一档，写了也永不生效⇒按"零效果的守卫直接删"不写。
  //  · 抛出面（桥层 reject，不走 safeHandle 的信封）改前只有一条会消失的 toast、常驻那句没人写
  //    （§251：两条到货的路都要有出口）。这一条**演得出**：挂载那一发抛出⇒`models` 仍是 null⇒走 §222 那句。
  const tRef = useRef(t)
  tRef.current = t
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError

  // §351：这一发从"effect 体内联"抽成具名的一份——不是为了收干逐渲染重读（§347 已经用 `[]` 依赖收干了），
  // 而是失败那一支需要有个可再调的入口给那颗「重试」指；依赖仍是空的，行为与抽出前一致
  const reloadModels = useCallback(() => {
    window.pocketai
      .listUsageModels()
      // §221：失败对象写进 models ⇒ 下面 `models ?? []` 拦不住（它是真值），priceKey(...)／rows 那圈按数组用就崩
      // §222：onError 那条 toast 会消失，而这一格一直显示「加载中…」⇒ 原因同时留给常驻那句
      .then((r) => {
        if (hasIpcFailed(r)) {
          const msg = ipcFailText(r, tRef.current('common.unknownError'))
          setModelsErr(msg)
          onErrorRef.current(new Error(msg))
          return
        }
        setModels(r)
      })
      .catch((e) => {
        setModelsErr(errText(e, tRef.current('common.unknownError')))
        onErrorRef.current(e)
        reportIpcError('usage.listUsageModels')(e)
      })
  }, [])

  useEffect(() => {
    void reloadModels()
  }, [reloadModels])

  // 编辑行清单：历史模型（按最近使用）∪ 已配置但已无用量的 key，去重
  const rows = useMemo(() => {
    const seen = new Set<string>()
    const out: { key: string; provider: string; model: string }[] = []
    for (const m of models ?? []) {
      const key = priceKey(m.provider, m.model)
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
      // 失败走既有的 onError（它会 toast「操作失败：…」并**留着编辑态与草稿**）；
      // 不判就是"先报已保存、再用 {ok:false} 渲染 ⇒ 636 行 Object.keys(pricing.prices) 崩"（§214）
      if (hasIpcFailed(next)) {
        onError(new Error(ipcFailText(next, t('common.unknownError'))))
        return
      }
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
              <tr>
                <td colSpan={4} className="py-3 px-2 text-[var(--color-text-muted)]">
                  {/* §351：这一发只有挂载一个读者（§347 把逐渲染重读收干成 `reloadModels`），失败时同屏没有任何东西会再跑它
                      ——收起再展开算重新挂载、不是"重读"的出口，所以给同级一颗键；键不挂旧值横幅的理由见 §347 那段注释 */}
                  {modelsErr ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <LoadFailNotice msg={modelsErr} />
                      <button
                        data-testid="price-models-read-retry"
                        className="text-xs underline text-[var(--color-text-muted)]"
                        onClick={reloadModels}
                      >
                        {t('agent.retryRead')}
                      </button>
                    </div>
                  ) : t('common.loading')}
                </td>
              </tr>
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

/** Provider 饼图色板（与主题色协调的固定色组） */
const PROVIDER_COLORS = [
  'var(--color-accent)',
  '#5b8def',
  '#f59e0b',
  '#10b981',
  '#8b5cf6',
  '#ec4899',
  '#64748b'
]

/** Provider 环形图：纯 CSS conic-gradient 实现，Top5 直接展示，其余归「其他」 */
const ProviderPie: React.FC<{
  providers: UsageSummary['byProvider']
}> = ({ providers }) => {
  const { t } = useI18n()
  if (providers.length === 0) return null
  const total = providers.reduce((s, p) => s + p.totalTokens, 0)
  if (total === 0) return null

  // Top5 + 其他聚合
  const top = providers.slice(0, 5)
  const restTokens = providers.slice(5).reduce((s, p) => s + p.totalTokens, 0)
  const segments: Array<{ label: string; tokens: number; color: string }> = top.map((p, i) => ({
    label: p.provider,
    tokens: p.totalTokens,
    color: PROVIDER_COLORS[i % PROVIDER_COLORS.length]!
  }))
  if (restTokens > 0) {
    segments.push({ label: t('usage.otherProviders'), tokens: restTokens, color: PROVIDER_COLORS[5]! })
  }

  // conic-gradient stops
  let acc = 0
  const stops = segments
    .map((s) => {
      const start = (acc / total) * 360
      acc += s.tokens
      const end = (acc / total) * 360
      return `${s.color} ${start}deg ${end}deg`
    })
    .join(', ')

  return (
    <div className="shrink-0 flex flex-col items-center gap-1">
      <div
        className="w-20 h-20 rounded-full"
        style={{ background: `conic-gradient(${stops})` }}
        role="img"
        aria-label={t('usage.byProvider')}
      />
      <div className="text-[10px] text-[var(--color-text-muted)]">
        {segments.length > 5 ? t('usage.providerShare', { n: 5 }) : ''}
      </div>
    </div>
  )
}

const StatCard: React.FC<{ label: string; value: string; hint?: string }> = ({ label, value, hint }) => (
  <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] px-3 py-2">
    <div className="text-[10px] text-[var(--color-text-muted)]">{label}</div>
    <div className="text-base font-semibold font-mono text-[var(--color-text)] mt-0.5" title={hint}>{value}</div>
  </div>
)

/** 预算行：label + 已花/上限 + 进度条；超限时进度条与金额变红并显示超支文案 */
const BudgetRow: React.FC<{ label: string; limit: number | null; cost: number; symbol: string; overText: string }> = ({ label, limit, cost, symbol, overText }) => {
  const over = limit !== null && limit > 0 && cost > limit
  const pct = limit !== null && limit > 0 ? Math.min((cost / limit) * 100, 100) : 0
  return (
    <div className="mb-1.5 last:mb-0">
      <div className="flex justify-between text-[11px] mb-0.5">
        <span className="text-[var(--color-text-muted)]">{label}</span>
        <span className={over ? 'text-[var(--color-danger)] font-semibold' : 'text-[var(--color-text)]'}>
          {symbol}{fmtCost(cost)} / {limit !== null ? `${symbol}${fmtCost(limit)}` : '—'}
          {over && <span className="ml-1.5">{overText}</span>}
        </span>
      </div>
      {limit !== null && (
        <div className="h-1.5 rounded bg-[var(--color-bg)] overflow-hidden">
          <div
            className={`h-full rounded ${over ? 'bg-[var(--color-danger)]' : 'bg-[var(--color-accent)]'} opacity-80`}
            style={{ width: `${Math.max(pct, cost > 0 ? 2 : 0)}%` }}
          />
        </div>
      )}
    </div>
  )
}
