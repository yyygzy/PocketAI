// 提醒中心：待发（pending）管理 + 历史（已触发/已错过/已取消）查阅
// 挂载于主窗口 App.tsx；打开期间到点/取消的广播会触发自动重拉
import React, { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { useToast } from './ToastProvider'
import { reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'
import type { ReminderRecord, ReminderRepeatRule, ReminderStatus } from '../../../shared/types'

interface Props {
  onClose: () => void
}

type Tab = 'pending' | 'history'

/** 完整本地时间（含年月日，跨天提醒看得清） */
function formatFireAt(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** epoch ms → datetime-local input 值（YYYY-MM-DDTHH:mm，按本地时区） */
function toDatetimeLocal(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** datetime-local input 值 → epoch ms（按本地时区解析） */
function fromDatetimeLocal(s: string): number {
  return new Date(s).getTime()
}

/** 提醒数据变更（取消/创建）后通知角标等外部 UI 刷新 */
function notifyChanged(): void {
  window.dispatchEvent(new Event('pocketai:reminders-changed'))
}

/** 历史行右侧状态徽标样式（终态三色弱化） */
function statusBadgeClass(status: ReminderStatus): string {
  if (status === 'fired') {
    return 'bg-[var(--color-success,#22c55e)] bg-opacity-15 text-[var(--color-success,#22c55e)]'
  }
  if (status === 'missed') {
    return 'bg-[var(--color-warning,#eab308)] bg-opacity-15 text-[var(--color-warning,#eab308)]'
  }
  return 'bg-[var(--color-text-muted)] bg-opacity-15 text-[var(--color-text-muted)]'
}

export const RemindersModal: React.FC<Props> = ({ onClose }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('pending')
  const [items, setItems] = useState<ReminderRecord[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editing, setEditing] = useState<ReminderRecord | null>(null)

  const reload = useCallback(async (scope: Tab) => {
    try {
      setItems(await window.pocketai.listReminders(scope))
    } catch (e) {
      reportIpcError('reminder.list')(e)
    }
  }, [])

  useEffect(() => {
    setItems(null)
    void reload(tab)
  }, [tab, reload])

  // 打开期间订阅到点广播与本地变更事件：触发后该条消失/进历史、取消后即时反映
  useEffect(() => {
    const off = window.pocketai.onReminderFired(() => {
      void reload(tab)
    })
    const onLocalChanged = () => void reload(tab)
    window.addEventListener('pocketai:reminders-changed', onLocalChanged)
    return () => {
      off()
      window.removeEventListener('pocketai:reminders-changed', onLocalChanged)
    }
  }, [tab, reload])

  const handleCancel = async (id: string) => {
    setBusyId(id)
    try {
      const r = await window.pocketai.cancelReminder(id)
      if (r.ok) {
        toast.success(t('reminder.center.cancelOk'))
        notifyChanged()
      }
      await reload(tab)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  // 历史 tab missed 循环提醒一键「重新安排」：按原 rule 重算下次触发回 pending
  const handleRescheduleNext = async (id: string) => {
    setBusyId(id)
    try {
      const r = await window.pocketai.rescheduleNextReminder(id)
      if (r.ok) {
        toast.success(t('reminder.center.rescheduleOk'))
        notifyChanged()
      } else {
        toast.error(t('reminder.center.rescheduleFail'))
      }
      await reload(tab)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-[520px] max-w-[95vw] max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <h3 className="text-sm font-semibold">⏰ {t('reminder.center.title')}</h3>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="px-3 pt-2 flex gap-1">
          {(['pending', 'history'] as Tab[]).map((tb) => (
            <button
              key={tb}
              onClick={() => setTab(tb)}
              className={
                'px-3 py-1 text-xs rounded-t border-b-2 transition-colors ' +
                (tab === tb
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)] font-medium'
                  : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]')
              }
            >
              {t(tb === 'pending' ? 'reminder.center.tabPending' : 'reminder.center.tabHistory')}
            </button>
          ))}
        </div>

        <div className="p-3 overflow-y-auto flex-1">
          {items === null ? (
            <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">{t('common.loading')}</p>
          ) : items.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">
              {t(tab === 'pending' ? 'reminder.center.empty' : 'reminder.center.historyEmpty')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {items.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center gap-3 px-3 py-2 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" title={r.text}>{r.text}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {formatFireAt(r.fireAt)}
                      {r.conversationId && (
                        <span className="ml-1.5 px-1 py-px rounded text-[10px] bg-[var(--color-accent)] bg-opacity-15 text-[var(--color-accent)]">
                          {t('reminder.center.fromChat')}
                        </span>
                      )}
                    </div>
                  </div>
                  {tab === 'pending' ? (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setEditing(r)}
                        disabled={busyId === r.id}
                        className="btn-ghost text-[11px] text-[var(--color-accent)] disabled:opacity-50"
                      >
                        {t('reminder.center.edit')}
                      </button>
                      <button
                        onClick={() => void handleCancel(r.id)}
                        disabled={busyId === r.id}
                        className="btn-ghost text-[11px] text-[var(--color-danger)] disabled:opacity-50"
                      >
                        {t('reminder.center.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      {/* missed 循环提醒：一键重新安排（按原 rule 重算下次触发回 pending） */}
                      {r.status === 'missed' && r.repeatRule && (
                        <button
                          onClick={() => void handleRescheduleNext(r.id)}
                          disabled={busyId === r.id}
                          className="btn-ghost text-[11px] text-[var(--color-accent)] disabled:opacity-50"
                        >
                          {t('reminder.center.reschedule')}
                        </button>
                      )}
                      <span
                        className={
                          'px-1.5 py-px rounded text-[10px] ' + statusBadgeClass(r.status)
                        }
                      >
                        {t(
                          r.status === 'fired'
                            ? 'reminder.center.statusFired'
                            : r.status === 'missed'
                              ? 'reminder.center.statusMissed'
                              : 'reminder.center.statusCancelled'
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 编辑 pending 提醒：弹层改时间/文本/循环规则 */}
      {editing && (
        <EditReminderDialog
          record={editing}
          onClose={() => setEditing(null)}
          onDone={async () => {
            await reload(tab)
            notifyChanged()
          }}
        />
      )}
    </div>
  )
}

// 编辑 pending 提醒弹窗：仿 RenameDocDialog overlay 模式；可改 text/fireAt/repeatRule
const EditReminderDialog: React.FC<{
  record: ReminderRecord
  onClose: () => void
  onDone: () => Promise<void> | void
}> = ({ record, onClose, onDone }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [text, setText] = useState(record.text)
  const [fireAtLocal, setFireAtLocal] = useState(toDatetimeLocal(record.fireAt))
  // repeatRule 编辑态：'none'=清除变一次性；'daily'/'weekly'/'monthly'=对应规则
  const initialKind = record.repeatRule?.kind ?? 'none'
  const [ruleKind, setRuleKind] = useState<'none' | 'daily' | 'weekly' | 'monthly'>(initialKind)
  const [intervalDays, setIntervalDays] = useState(
    record.repeatRule?.kind === 'daily' ? String(record.repeatRule.intervalDays) : '1'
  )
  const [weekdays, setWeekdays] = useState<number[]>(
    record.repeatRule?.kind === 'weekly' ? record.repeatRule.weekdays : [1]
  )
  const [dayOfMonth, setDayOfMonth] = useState(
    record.repeatRule?.kind === 'monthly' ? String(record.repeatRule.dayOfMonth) : '1'
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError('')
    try {
      const fireAt = fromDatetimeLocal(fireAtLocal)
      if (!Number.isFinite(fireAt)) {
        setError(t('reminder.center.errFireAt'))
        return
      }
      let repeatRule: ReminderRepeatRule | null
      if (ruleKind === 'none') {
        repeatRule = null
      } else if (ruleKind === 'daily') {
        const d = Math.max(1, Math.min(365, Math.floor(Number(intervalDays) || 1)))
        repeatRule = { kind: 'daily', intervalDays: d }
      } else if (ruleKind === 'weekly') {
        const wds = weekdays.slice().sort((a, b) => a - b)
        if (wds.length === 0) {
          setError(t('reminder.center.errWeekdays'))
          return
        }
        repeatRule = { kind: 'weekly', weekdays: wds }
      } else {
        const dom = Math.max(1, Math.min(31, Math.floor(Number(dayOfMonth) || 1)))
        repeatRule = { kind: 'monthly', dayOfMonth: dom }
      }
      const r = await window.pocketai.updateReminder({
        id: record.id,
        text: trimmed,
        fireAt,
        repeatRule
      })
      if (!r.ok) {
        setError(t('reminder.center.editFail'))
        return
      }
      toast.success(t('reminder.center.editOk'))
      await onDone()
      onClose()
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const toggleWeekday = (d: number) => {
    setWeekdays((prev) =>
      prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
    )
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-overlay)]"
      onClick={onClose}
    >
      <div
        className="w-[460px] bg-[var(--color-sidebar)] rounded-lg border border-[var(--color-border)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
          <h3 className="text-sm font-semibold">{t('reminder.center.editTitle')}</h3>
          <button onClick={onClose} className="btn-ghost text-xs">
            {t('common.close')}
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">
              {t('reminder.center.fieldText')}
            </label>
            <textarea
              className="input w-full resize-none"
              rows={2}
              maxLength={500}
              value={text}
              autoFocus
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">
              {t('reminder.center.fieldFireAt')}
            </label>
            <input
              type="datetime-local"
              className="input w-full"
              value={fireAtLocal}
              onChange={(e) => setFireAtLocal(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">
              {t('reminder.center.fieldRepeat')}
            </label>
            <select
              className="input w-full"
              value={ruleKind}
              onChange={(e) => setRuleKind(e.target.value as typeof ruleKind)}
            >
              <option value="none">{t('reminder.center.repeatNone')}</option>
              <option value="daily">{t('reminder.center.repeatDaily')}</option>
              <option value="weekly">{t('reminder.center.repeatWeekly')}</option>
              <option value="monthly">{t('reminder.center.repeatMonthly')}</option>
            </select>
          </div>
          {ruleKind === 'daily' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--color-text-muted)]">
                {t('reminder.center.intervalDays')}
              </label>
              <input
                type="number"
                min={1}
                max={365}
                className="input w-20"
                value={intervalDays}
                onChange={(e) => setIntervalDays(e.target.value)}
              />
            </div>
          )}
          {ruleKind === 'weekly' && (
            <div className="flex flex-wrap gap-1">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleWeekday(d)}
                  className={
                    'px-2 py-1 text-xs rounded border transition-colors ' +
                    (weekdays.includes(d)
                      ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] border-[var(--color-accent)]'
                      : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]')
                  }
                >
                  {t(`reminder.center.weekday.${d}`)}
                </button>
              ))}
            </div>
          )}
          {ruleKind === 'monthly' && (
            <div className="flex items-center gap-2">
              <label className="text-xs text-[var(--color-text-muted)]">
                {t('reminder.center.dayOfMonth')}
              </label>
              <input
                type="number"
                min={1}
                max={31}
                className="input w-20"
                value={dayOfMonth}
                onChange={(e) => setDayOfMonth(e.target.value)}
              />
            </div>
          )}
          {error && <p className="text-xs text-[var(--color-danger)]">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-[var(--color-border)]">
          <button onClick={onClose} className="btn-ghost text-xs">
            {t('common.cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!text.trim() || busy}
            className="btn-accent text-xs disabled:opacity-50"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}
