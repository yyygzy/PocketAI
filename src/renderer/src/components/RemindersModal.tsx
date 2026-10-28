// 提醒中心：待发（pending）管理 + 历史（已触发/已错过/已取消）查阅
// 挂载于主窗口 App.tsx；打开期间到点/取消的广播会触发自动重拉
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { useToast } from './ToastProvider'
import { reportIpcError, hasIpcFailed, ipcFailText } from '../utils/ipc'
import { LoadFailNotice } from './LoadFailNotice'
import { StaleValueNotice } from './StaleValueNotice'
import { errText } from '../utils/error'
import { repeatRuleLabel } from '../../../shared/reminder-rule'
import type { ReminderRecord, ReminderRepeatRule, ReminderStatus } from '../../../shared/types'

interface Props {
  onClose: () => void
}

type Tab = 'pending' | 'history'

/** 改期弹窗的默认时间：终态行的原时间必是过去，预填它等于预填一个必然报错的值 */
function rescheduleDefaultFireAt(): number {
  const d = new Date(Date.now() + 60 * 60_000)
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0)
  return d.getTime()
}

/** 完整本地时间（含年月日，跨天提醒看得清） */
function formatFireAt(ms: number): string {
  return new Date(ms).toLocaleString()
}

/** 循环规则词条注入：徽标文案由调用方给语言，纯函数只管结构（见 src/shared/reminder-rule.ts） */
function buildRuleWords(t: (key: string, params?: Record<string, string | number>) => string) {
  return {
    daily: (n: number) => t('reminder.center.ruleDaily', { interval: n }),
    weekly: (days: string) => t('reminder.center.ruleWeekly', { days }),
    monthly: (n: number) => t('reminder.center.ruleMonthly', { day: n }),
    weekday: (n: number) => t(`reminder.center.weekday.${n}`),
    separator: t('reminder.center.weekdaySep')
  }
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
  const ruleWords = buildRuleWords(t)
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('pending')
  // §311：`reload(scope)` 是 async——来回快速点两个 tab 时，前一个 tab 那一发可能后到，
  // 于是「历史」tab 摆着「待发」那批记录（行内按钮与徽标是按 tab 画的 ⇒ 对着一张错表点「改期」）。
  // 判据同 §309／§264：「这一发是不是还给当前 tab」。ref 在 render 期同步，首次加载不会误挡。
  const tabRef = useRef<Tab>(tab)
  tabRef.current = tab
  const [items, setItems] = useState<ReminderRecord[] | null>(null)
  // §222 同一口径：读不到就明说，别把列表长期挂在「加载中…」上
  const [loadErr, setLoadErr] = useState<string | null>(null)
  // §332：在飞态改成一"行"一格。改前是一个单槽 `busyId`——连点 A、B 两行取消时 A 先回，
  // finally 把那一格清掉，而 B 那一发还在飞 ⇒ B 的按钮重新可点，双击 B 就得到第二次
  // `{ok:false}`（已取消的不能重复取消）⇒ **已经取消成功却弹一句「取消失败（提醒可能已触发）」**
  const [busyIds, setBusyIds] = useState<Record<string, true>>({})
  const markBusy = (id: string, on: boolean): void =>
    setBusyIds((prev) => {
      const next = { ...prev }
      if (on) next[id] = true
      else delete next[id]
      return next
    })
  // 弹窗有两种模式：pending 行编辑（update）与终态行改期（reschedule，把行拉回 pending）
  const [editing, setEditing] = useState<{
    record: ReminderRecord
    mode: 'edit' | 'reschedule'
  } | null>(null)

  const reload = useCallback(async (scope: Tab) => {
    try {
      // §223：`setItems(await listReminders())` 把失败对象直接写进列表 state ⇒
      // 下面 `items.length === 0` 为假、`items.map` 当场 TypeError（提醒中心整个打不开）。
      // §222 那个面在这里正好用上：读不到就明说读不到，别顶着「加载中…」
      const list = await window.pocketai.listReminders(scope)
      // §311：切走了就不替那个 tab 写屏，也不替它留一句「读不到」
      if (tabRef.current !== scope) return
      if (hasIpcFailed(list)) {
        setLoadErr(ipcFailText(list, t('common.unknownError')))
        return
      }
      // §347：成功那一发必须把上一句「刷新失败」收回——挂着就是拿一份已经刷新的清单说"这是旧值"
      setItems(list)
      setLoadErr(null)
    } catch (e) {
      // §347：抛出面（桥层 reject，不走 safeHandle 的 `{ok:false}`）以前只进 console，
      // 于是"两条到货的路"里有一条没人认领（§251 的口径）；切走了仍不替那个 tab 留话（§311）
      if (tabRef.current !== scope) return
      setLoadErr(errText(e, t('common.unknownError')))
      reportIpcError('reminder.list')(e)
    }
  }, [t])

  useEffect(() => {
    // §347：换 tab 时那份原因是**上一个** tab 那一发的，挂在新一屏的「读不到」位上＝张冠李戴
    setItems(null)
    setLoadErr(null)
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
    markBusy(id, true)
    try {
      const r = await window.pocketai.cancelReminder(id)
      if (r.ok) {
        toast.success(t('reminder.center.cancelOk'))
        notifyChanged()
      } else {
        // §334：改前 IPC 失败与业务拒绝（已取消／已触发）并成同一句⇒用户分不清哪边出了问题；
        // 现在 `ipcFailText` 优先读 r.error（safeHandle 兜住的 infrastructure 错误），没有才落回兜底键
        toast.error(ipcFailText(r, t('reminder.center.cancelFail')))
      }
      await reload(tab)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      markBusy(id, false)
    }
  }

  // 历史 tab missed 循环提醒一键「重新安排」：按原 rule 重算下次触发回 pending
  const handleRescheduleNext = async (id: string) => {
    markBusy(id, true)
    try {
      const r = await window.pocketai.rescheduleNextReminder(id)
      if (r.ok) {
        toast.success(t('reminder.center.rescheduleOk'))
        notifyChanged()
      } else {
        // §334：同 handleCancel——IPC 失败与业务拒绝（无循环规则／记录不存在）分开说
        toast.error(ipcFailText(r, t('reminder.center.rescheduleFail')))
      }
      await reload(tab)
    } catch (e) {
      toast.error(errText(e))
    } finally {
      markBusy(id, false)
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
          {/* §347：清单已经在屏上、这一发又没读到时＝§345 那一族的第八处。
              上面那条 `items === null` 的门只管"一发都没读到"，两者互斥、同块并存。 */}
          {items !== null && loadErr && (
            <div className="mb-2">
              <StaleValueNotice
                what={t('reminder.center.title')}
                msg={loadErr}
                onRetry={() => void reload(tab)}
                testid="reminders-list-stale-retry"
              />
            </div>
          )}
          {items === null ? (
            loadErr ? (
              <LoadFailNotice msg={loadErr} />
            ) : (
              <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">{t('common.loading')}</p>
            )
          ) : items.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] py-6 text-center">
              {t(tab === 'pending' ? 'reminder.center.empty' : 'reminder.center.historyEmpty')}
            </p>
          ) : (
            <div className="space-y-1.5">
              {items.map((r) => {
                const ruleLabel = repeatRuleLabel(r.repeatRule, ruleWords)
                return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 px-3 py-2 rounded bg-[var(--color-sidebar)] border border-[var(--color-border)]"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate" title={r.text}>{r.text}</div>
                    <div className="text-[11px] text-[var(--color-text-muted)] mt-0.5">
                      {formatFireAt(r.fireAt)}
                      {ruleLabel && (
                        <span className="ml-1.5 px-1 py-px rounded text-[10px] border border-[var(--color-border)]">
                          {ruleLabel}
                        </span>
                      )}
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
                        onClick={() => setEditing({ record: r, mode: 'edit' })}
                        disabled={!!busyIds[r.id]}
                        className="btn-ghost text-[11px] text-[var(--color-accent)] disabled:opacity-50"
                      >
                        {t('reminder.center.edit')}
                      </button>
                      <button
                        onClick={() => void handleCancel(r.id)}
                        disabled={!!busyIds[r.id]}
                        className="btn-ghost text-[11px] text-[var(--color-danger)] disabled:opacity-50"
                      >
                        {t('reminder.center.cancel')}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1 shrink-0">
                      {/* 终态行（fired/missed/cancelled）都能改期回 pending：后端 RESCHEDULE 早就能用，
                          此前渲染端一个入口都没接 */}
                      <button
                        onClick={() => setEditing({ record: r, mode: 'reschedule' })}
                        disabled={!!busyIds[r.id]}
                        className="btn-ghost text-[11px] text-[var(--color-accent)] disabled:opacity-50"
                      >
                        {t('reminder.center.rescheduleAt')}
                      </button>
                      {/* missed 循环提醒：一键重新安排（按原 rule 重算下次触发回 pending） */}
                      {r.status === 'missed' && r.repeatRule && (
                        <button
                          onClick={() => void handleRescheduleNext(r.id)}
                          disabled={!!busyIds[r.id]}
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
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 编辑 pending 提醒：弹层改时间/文本/循环规则 */}
      {editing && (
        <EditReminderDialog
          record={editing.record}
          mode={editing.mode}
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
  /** edit=改 pending 行（走 UPDATE）；reschedule=终态行改期回 pending（走 RESCHEDULE，不动文本） */
  mode: 'edit' | 'reschedule'
  onClose: () => void
  onDone: () => Promise<void> | void
}> = ({ record, mode, onClose, onDone }) => {
  const { t } = useI18n()
  const toast = useToast()
  const [text, setText] = useState(record.text)
  const [fireAtLocal, setFireAtLocal] = useState(
    toDatetimeLocal(mode === 'reschedule' ? rescheduleDefaultFireAt() : record.fireAt)
  )
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
      // RESCHEDULE 的 repeatRule 是 optional 且不接受 null（schema 会拒），一次性就不传该字段
      const r =
        mode === 'reschedule'
          ? await window.pocketai.rescheduleReminder({
              id: record.id,
              fireAt,
              ...(repeatRule ? { repeatRule } : {})
            })
          : await window.pocketai.updateReminder({
              id: record.id,
              text: trimmed,
              fireAt,
              repeatRule
            })
      if (!r.ok) {
        // 时间范围这类校验只有主进程知道原因，优先显示它的原文
        setError(r.error ?? t(mode === 'reschedule' ? 'reminder.center.rescheduleAtFail' : 'reminder.center.editFail'))
        return
      }
      toast.success(t(mode === 'reschedule' ? 'reminder.center.rescheduleAtOk' : 'reminder.center.editOk'))
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
          <h3 className="text-sm font-semibold">
            {t(mode === 'reschedule' ? 'reminder.center.rescheduleAtTitle' : 'reminder.center.editTitle')}
          </h3>
          <button onClick={onClose} className="btn-ghost text-xs">
            {t('common.close')}
          </button>
        </div>
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-xs text-[var(--color-text-muted)] mb-1">
              {t('reminder.center.fieldText')}
            </label>
            {mode === 'reschedule' ? (
              <div className="text-sm text-[var(--color-text)] break-words" title={record.text}>
                {record.text}
              </div>
            ) : (
              <textarea
                className="input w-full resize-none"
                rows={2}
                maxLength={500}
                value={text}
                autoFocus
                onChange={(e) => setText(e.target.value)}
              />
            )}
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
