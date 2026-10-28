// 「提醒我」锚点浮层：3 个相对时长 + 4 个定点预设（共用一个可选时间点）+ 自定义分钟。
// 三个循环项各带一条展开设置（每 N 天 / 周几 / 几号），省掉「先建周一再去提醒中心改」。
// 纯展示/输入组件，IPC 调用与文本截取由 ChatModule 统一处理（需要会话 id 与消息正文）。
import React, { useEffect, useMemo, useState } from 'react'
import { useI18n } from '../i18n'
import type { ReminderRepeatRule } from '../../../shared/types'
import { normalizeWeekdays, repeatRuleLabel } from '../../../shared/reminder-rule'
import {
  buildReminderPresets,
  clampReminderMinutes,
  DEFAULT_RULE_CONFIG,
  formatPresetMinute,
  presetMinuteOf,
  type PresetRuleConfig
} from '../utils/reminder-presets'

/** 带时间点参数的预设（其余为相对时间，不受时间输入影响） */
const AT_TIME_KEYS = new Set(['nextAt', 'everyDay', 'everyWeek', 'everyMonth'])
/** 可展开设置条的三个循环项 */
type RecurringKey = 'everyDay' | 'everyWeek' | 'everyMonth'
const RECURRING_KEYS: RecurringKey[] = ['everyDay', 'everyWeek', 'everyMonth']
const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7]

interface Props {
  anchor: { x: number; y: number }
  onPick: (fireAt: number, repeatRule?: ReminderRepeatRule) => void
  onClose: () => void
}

export const ReminderMenu: React.FC<Props> = ({ anchor, onPick, onClose }) => {
  const { t } = useI18n()
  const [hhmm, setHhmm] = useState('09:00')
  const minute = presetMinuteOf(hhmm)
  const timeText = formatPresetMinute(minute)
  const [cfg, setCfg] = useState<PresetRuleConfig>(DEFAULT_RULE_CONFIG)
  const [openKey, setOpenKey] = useState<RecurringKey | null>(null)
  // now 只在时间点或规则变化时重取，避免每次渲染让「15 分钟后」漂移
  const presets = useMemo(() => buildReminderPresets(Date.now(), minute, cfg), [minute, cfg])
  const [minutes, setMinutes] = useState('60')

  const ruleWords = useMemo(
    () => ({
      daily: (n: number) => t('reminder.center.ruleDaily', { interval: n }),
      weekly: (days: string) => t('reminder.center.ruleWeekly', { days }),
      monthly: (n: number) => t('reminder.center.ruleMonthly', { day: n }),
      weekday: (n: number) => t(`reminder.center.weekday.${n}`),
      separator: t('reminder.center.weekdaySep')
    }),
    [t]
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submitCustom = () => {
    const m = clampReminderMinutes(Number(minutes))
    onPick(Date.now() + m * 60_000)
  }

  const toggleWeekday = (d: number) => {
    setCfg((prev) => {
      const next = prev.weekdays.includes(d)
        ? prev.weekdays.filter((x) => x !== d)
        : [...prev.weekdays, d]
      // 取消最后一个星期 = 不响应：schema 要求至少 1 天，给空数组会被静默回落成周一，
      // 用户会以为「取消勾选=不循环」，而实际仍建出一条循环提醒
      if (next.length === 0) return prev
      return { ...prev, weekdays: normalizeWeekdays(next) }
    })
  }

  /** 循环项的标签要说清实际规则，写死「每周一」而用户勾了周三就是骗人 */
  const labelOf = (key: string, rule?: ReminderRepeatRule): string => {
    if (!AT_TIME_KEYS.has(key)) return t(`reminder.menu.${key}`)
    if (!rule) return t(`reminder.menu.${key}`, { time: timeText })
    if (key === 'everyDay' && rule.kind === 'daily' && rule.intervalDays === 1) {
      return t('reminder.menu.everyDay', { time: timeText })
    }
    return `${repeatRuleLabel(rule, ruleWords)} ${timeText}`
  }

  const inputCls =
    'w-14 px-1.5 py-0.5 text-[11px] rounded border border-[var(--color-border)] bg-[var(--color-input-bg,var(--color-sidebar))] outline-none focus:border-[var(--color-accent)]'

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose() }} />
      <div
        className="fixed z-50 w-48 py-1 rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] shadow-xl"
        style={{
          left: Math.min(anchor.x, window.innerWidth - 200),
          // 展开设置条时浮层变高，贴底时留出更多空间免得被裁掉
          top: Math.min(anchor.y, window.innerHeight - (openKey ? 380 : 280))
        }}
      >
        <div className="px-3 pt-1 pb-1 text-[11px] text-[var(--color-text-muted)]">{t('reminder.menu.remindMe')}</div>
        {presets.map((p) => {
          const recurring = (RECURRING_KEYS as string[]).includes(p.key)
          const isOpen = openKey === p.key
          return (
            <div key={p.key}>
              <div className="flex items-stretch">
                <button
                  className="flex-1 min-w-0 text-left px-3 py-1.5 text-xs text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-accent)] transition-colors"
                  onClick={() => onPick(p.fireAt, p.repeatRule)}
                >
                  {labelOf(p.key, p.repeatRule)}
                </button>
                {recurring && (
                  <button
                    type="button"
                    aria-label={t('reminder.menu.rule')}
                    title={t('reminder.menu.rule')}
                    aria-expanded={isOpen}
                    onClick={() => setOpenKey(isOpen ? null : (p.key as RecurringKey))}
                    className="px-2 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                  >
                    {isOpen ? '▾' : '▸'}
                  </button>
                )}
              </div>
              {isOpen && p.key === 'everyDay' && (
                <div className="flex items-center gap-1.5 px-3 pb-1">
                  <label className="text-[10px] text-[var(--color-text-muted)]" htmlFor="reminder-preset-interval">
                    {t('reminder.center.intervalDays')}
                  </label>
                  <input
                    id="reminder-preset-interval"
                    className={inputCls + ' ml-auto'}
                    type="number"
                    min={1}
                    max={365}
                    value={cfg.intervalDays}
                    onChange={(e) => setCfg((prev) => ({ ...prev, intervalDays: Number(e.target.value) }))}
                  />
                </div>
              )}
              {isOpen && p.key === 'everyWeek' && (
                <div className="flex flex-wrap gap-0.5 px-3 pb-1">
                  {WEEKDAYS.map((d) => {
                    const on = cfg.weekdays.includes(d)
                    return (
                      <button
                        key={d}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleWeekday(d)}
                        className={
                          'px-1.5 py-0.5 text-[10px] rounded border transition-colors ' +
                          (on
                            ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] border-[var(--color-accent)]'
                            : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]')
                        }
                      >
                        {t(`reminder.center.weekday.${d}`)}
                      </button>
                    )
                  })}
                </div>
              )}
              {isOpen && p.key === 'everyMonth' && (
                <div className="flex items-center gap-1.5 px-3 pb-1">
                  <label className="text-[10px] text-[var(--color-text-muted)]" htmlFor="reminder-preset-day">
                    {t('reminder.center.dayOfMonth')}
                  </label>
                  <input
                    id="reminder-preset-day"
                    className={inputCls + ' ml-auto'}
                    type="number"
                    min={1}
                    max={31}
                    value={cfg.dayOfMonth}
                    onChange={(e) => setCfg((prev) => ({ ...prev, dayOfMonth: Number(e.target.value) }))}
                  />
                </div>
              )}
            </div>
          )
        })}
        <div className="flex items-center gap-1.5 px-2 pt-1.5">
          <label className="text-[11px] text-[var(--color-text-muted)] whitespace-nowrap" htmlFor="reminder-preset-time">
            {t('reminder.menu.atTime')}
          </label>
          <input
            id="reminder-preset-time"
            type="time"
            value={hhmm}
            onChange={(e) => setHhmm(e.target.value)}
            className="ml-auto w-[86px] px-1.5 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-input-bg,var(--color-sidebar))] outline-none focus:border-[var(--color-accent)]"
          />
        </div>
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-[var(--color-border)] mt-1">
          <input
            type="number"
            min={1}
            max={43200}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); submitCustom() }
            }}
            className="w-16 px-1.5 py-1 text-xs rounded border border-[var(--color-border)] bg-[var(--color-input-bg,var(--color-sidebar))] outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
            {t('reminder.menu.customMinutes')}
          </span>
          <button
            onClick={submitCustom}
            className="ml-auto text-[11px] px-2 py-1 rounded bg-[var(--color-accent)] text-[var(--color-on-accent)] hover:opacity-90"
          >
            {t('reminder.menu.create')}
          </button>
        </div>
      </div>
    </>
  )
}
