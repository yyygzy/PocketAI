// Agent 评测集的界面入口（V4-Iter-242）。
//
// §233 把判分／聚合／运行侧都落了地，但"跑评测"这件事只有测试和手工调函数做得到——
// 于是关于 Agent 的每一句判断仍然来自读码。这一屏要改的就是那一句：数字得点得开、还得能读回来。
//
// 三条不是可省的细节：
//  · **跑的是模型栏里现在这台**，这里不给换台。换台＝换自变量，那一趟的数字就该另开一趟。
//  · **进度必须有**。一趟是分钟级（每发十几秒到几十秒），没进度界面就长成"点了没反应"。
//  · **旧报告要能读回来**。每次打开都重跑一遍是真花额度的，所以清单里那几份才是这一屏的默认读数。
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../../../i18n'
import { hasIpcFailed, ipcFailureText } from '../../../utils/ipc'
import { errText } from '../../../utils/error'
import {
  AGENT_EVAL_MAX_K,
  type AgentEvalProgressEvent,
  type AgentEvalReportEntry,
  type AgentEvalRunResult
} from '../../../../../shared/agent-eval'

const pct = (v: number): string => `${Math.round(v * 100)}%`

/**
 * §328：「这一趟在跑」不是面板的私事，所以不放在组件态里。
 * 主进程按模块级 `activeEval` 只许一趟（`ipc/handlers/agent.ts`），而面板关得掉、切得掉：
 * 改前那颗「停下」挂在组件态 `busy` 上 ⇒ 面板一收，键就没了，重开后又看见「已经在跑，
 * 请等它结束或先点『停下』」这句指向一颗屏上不存在的键（进度到货同样不画，因为
 * `running = busy && progress`）。这一份状态跟着那一趟走：发起 ⇒ 置位，自己那一趟落地 ⇒ 清零，
 * 进度到货 ⇒ 置位并记下最新一份（覆盖"渲染端重走过、什么都不知道"那一段），
 * 「停下」拿到 `stopped:false` ⇒ 清零（那一刻主进程说没有东西在跑，这是最硬的一句）。
 */
const runState = { inFlight: false, progress: null as AgentEvalProgressEvent | null }
const runListeners = new Set<() => void>()
function patchRunState(patch: Partial<typeof runState>): void {
  Object.assign(runState, patch)
  runListeners.forEach((l) => l())
}

interface Props {
  providerId: string
  model: string
  /** 目标那台的显示名（评测跑的就是模型栏当前这台，这里不给换台） */
  targetLabel: string
  onClose: () => void
}

export const AgentEvalPanel: React.FC<Props> = ({ providerId, model, targetLabel, onClose }) => {
  const { t } = useI18n()
  const [tier, setTier] = useState<'smoke' | 'full'>('smoke')
  const [kText, setKText] = useState('2')
  const [error, setError] = useState('')
  // §328：「在跑」与「最新那份进度」都从模块级 `runState` 镜像过来（下面那个订阅会写它），
  // 所以面板关掉再打开、或切走模块再切回来，看见的还是同一趟的读数
  const [inFlight, setInFlight] = useState(runState.inFlight)
  const [sharedProgress, setSharedProgress] = useState<AgentEvalProgressEvent | null>(runState.progress)
  const [result, setResult] = useState<AgentEvalRunResult | null>(null)
  /** `null`＝还没读；字符串＝读失败的那句原因；数组＝清单（空数组就是"没跑过"，不是"读不到"） */
  const [reports, setReports] = useState<AgentEvalReportEntry[] | null>(null)
  const [reportsError, setReportsError] = useState('')
  const [reportText, setReportText] = useState('')
  // 停止按钮要打得断**正在跑的那一发**，id 由主进程那一侧记着，界面只管发一次「停下」
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const loadReports = useCallback(async () => {
    const r = await window.pocketai.listAgentEvalReports()
    if (!mountedRef.current) return
    if (hasIpcFailed(r)) {
      setReports(null)
      setReportsError(ipcFailureText(r, t))
      return
    }
    setReports(r)
    setReportsError('')
  }, [t])

  // 打开这一屏就把旧报告读回来：默认读数不该是"空着，等你再花一遍额度"
  useEffect(() => {
    void loadReports()
  }, [loadReports])

  useEffect(() => {
    if (typeof window.pocketai.onAgentEvalProgress !== 'function') return
    return window.pocketai.onAgentEvalProgress((event) => {
      // 进度到货就说明那一趟真在跑（哪怕这一发是别的窗口、或渲染端重走过发起的）。
      // 写模块级状态这一句**不能挂在 mounted 判断后面**：面板收着的时候也要把读数存住
      patchRunState({ inFlight: true, progress: event })
    })
  }, [])

  // §328：面板重开时先对账一次模块级状态，再订阅它
  useEffect(() => {
    const sync = () => {
      setInFlight(runState.inFlight)
      setSharedProgress(runState.progress)
    }
    runListeners.add(sync)
    return () => {
      runListeners.delete(sync)
    }
  }, [])

  const run = async (): Promise<void> => {
    setError('')
    // 领号在 await 之前：这一发起跑就该让「停下」出现在屏上
    patchRunState({ inFlight: true, progress: null })
    // 「已经在跑」那一支不许在 finally 里把状态清掉（清了就又回到"键不存在"）
    let keepInFlight = false
    try {
      const k = Math.min(AGENT_EVAL_MAX_K, Math.max(1, Number(kText) || 1))
      const r = await window.pocketai.runAgentEval({ providerId, model, tier, k })
      if (hasIpcFailed(r)) {
        // 「已经在跑」「现在有 Agent 运行」都是回码：句子按语言出，不把这行中文贴到界面上
        setError(ipcFailureText(r, t))
        // 「已经有趟在跑」＝那一趟仍在，别在 finally 里把自己那份读数抹掉（keepInFlight 那条有牙，见 Z10）
        if ((r as { ipcCode?: string }).ipcCode === 'EVAL_ALREADY_RUNNING') keepInFlight = true
        return
      }
      setResult(r)
      void loadReports()
    } catch (e) {
      setError(errText(e))
    } finally {
      if (!keepInFlight) patchRunState({ inFlight: false, progress: null })
    }
  }

  const stop = async (): Promise<void> => {
    const r = await window.pocketai.stopAgentEval()
    if (hasIpcFailed(r)) {
      setError(ipcFailureText(r, t))
      return
    }
    // stopped:false 不是失败：那一趟正好自己跑完了，这里只把"停过了"这件事说一声；
    // 同时它也是最硬的一句「现在没有东西在跑」⇒ 屏上那颗键该收回去
    if (!r.stopped) {
      setError(t('agent.eval.stoppedNote'))
      patchRunState({ inFlight: false, progress: null })
    }
  }

  const openReport = async (fileName: string): Promise<void> => {
    const r = await window.pocketai.readAgentEvalReport(fileName)
    if (hasIpcFailed(r)) {
      setError(ipcFailureText(r, t))
      return
    }
    setReportText(r.text)
  }

  // §328：进度那一行与那颗「停下」都按"这一趟在跑"来判，而不是按"这个面板实例发起过"
  const shownProgress = sharedProgress

  return (
    <div
      data-testid="agent-eval-panel"
      className="mb-2 self-start w-full max-w-[640px] rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2.5 space-y-2 text-xs"
    >
      <div className="flex items-center justify-between gap-2">
        <h4 className="font-semibold">{t('agent.eval.title')}</h4>
        <button
          onClick={onClose}
          data-testid="agent-eval-close"
          className="px-1.5 py-0.5 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        >
          {t('common.close')}
        </button>
      </div>

      <p className="text-[var(--color-text-muted)]">{t('agent.eval.targetHint', { name: targetLabel })}</p>

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={tier}
          data-testid="agent-eval-tier"
          disabled={inFlight}
          onChange={(e) => setTier(e.target.value === 'full' ? 'full' : 'smoke')}
          className="input text-xs"
        >
          <option value="smoke">{t('agent.eval.tierSmoke')}</option>
          <option value="full">{t('agent.eval.tierFull')}</option>
        </select>
        <label htmlFor="agent-eval-k">{t('agent.eval.k')}</label>
        <input
          id="agent-eval-k"
          data-testid="agent-eval-k"
          className="input w-14 text-xs"
          value={kText}
          inputMode="numeric"
          disabled={inFlight}
          onChange={(e) => setKText(e.target.value.replace(/[^0-9]/g, ''))}
        />
        <button
          onClick={() => void run()}
          disabled={inFlight}
          data-testid="agent-eval-run"
          className="btn-accent text-xs disabled:opacity-50"
        >
          {t('agent.eval.run')}
        </button>
        {inFlight && (
          <button onClick={() => void stop()} data-testid="agent-eval-stop" className="btn-ghost text-xs">
            {t('common.stop')}
          </button>
        )}
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)]">{t('agent.eval.hint')}</p>
      {/* 全局工作目录那件事不是实现细节，是用户会踩的坑：评测一头发一发地切它 */}
      <p className="text-[11px] text-[var(--color-warning)]">{t('agent.eval.workspaceWarn')}</p>

      {inFlight && shownProgress && (
        <p data-testid="agent-eval-progress" className="text-[var(--color-accent)]">
          {t('agent.eval.progress', {
            done: shownProgress.done + 1,
            total: shownProgress.total,
            task: shownProgress.current ? `${shownProgress.current.taskId}#${shownProgress.current.attempt}` : ''
          })}
        </p>
      )}

      {error && <p data-testid="agent-eval-error" className="text-[var(--color-danger)]">{error}</p>}

      {result && (
        <div className="space-y-1" data-testid="agent-eval-result">
          <div className="flex flex-wrap gap-x-3">
            <span>{t('agent.eval.reliable', { n: result.report.reliable, total: result.report.tasks })}</span>
            <span>{t('agent.eval.everPassed', { n: result.report.everPassed, total: result.report.tasks })}</span>
            {result.report.deadTasks > 0 && (
              <span className="text-[var(--color-danger)]">
                {t('agent.eval.deadTasks', { n: result.report.deadTasks })}
              </span>
            )}
          </div>
          {result.interrupted && (
            <p className="text-[11px] text-[var(--color-warning)]">{t('agent.eval.stoppedNote')}</p>
          )}
          <ul className="space-y-0.5 text-[11px]">
            {result.report.perTask.map((p) => (
              <li key={p.id} data-eval-task={p.id}>
                {p.id}：pass@1 {pct(p.passAt1)}（{p.passed}/{p.attempts - p.notRan}）· pass^{result.k}{' '}
                {p.passAllK ? t('agent.eval.allPassed') : t('agent.eval.notAllPassed')}
                {p.notRan > 0 && ` · ${t('agent.eval.notRan', { n: p.notRan })}`}
                {p.stepOverruns > 0 && ` · ${t('agent.eval.stepOverran', { n: p.stepOverruns })}`}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[var(--color-text-muted)]">
            {t('agent.eval.reportPath', { path: result.reportPath })}
          </p>
        </div>
      )}

      <div className="space-y-1">
        <p className="text-[11px] text-[var(--color-text-muted)]">{t('agent.eval.reportsTitle')}</p>
        {reportsError && (
          <p data-testid="agent-eval-reports-unread" className="text-[var(--color-danger)]">
            {reportsError}
            <button onClick={() => void loadReports()} data-testid="agent-eval-reports-retry" className="ml-1.5 underline">
              {t('agent.retryRead')}
            </button>
          </p>
        )}
        {!reportsError && reports === null && <p className="text-[11px]">{t('agent.eval.reportsLoading')}</p>}
        {!reportsError && reports !== null && reports.length === 0 && (
          <p data-testid="agent-eval-reports-empty" className="text-[11px] text-[var(--color-text-muted)]">
            {t('agent.eval.reportsEmpty')}
          </p>
        )}
        {!reportsError && (reports?.length ?? 0) > 0 && (
          <ul className="space-y-0.5 text-[11px]">
            {reports?.map((r) => (
              <li key={r.fileName}>
                <button
                  onClick={() => void openReport(r.fileName)}
                  data-eval-report={r.fileName}
                  className="underline text-[var(--color-accent)]"
                >
                  {t('agent.eval.openReport')}
                </button>{' '}
                {r.firstLine}
              </li>
            ))}
          </ul>
        )}
        {reportText && (
          <pre
            data-testid="agent-eval-report-text"
            className="max-h-48 overflow-auto whitespace-pre-wrap text-[11px] rounded border border-[var(--color-border)] p-2"
          >
            {reportText}
          </pre>
        )}
      </div>
    </div>
  )
}

export default AgentEvalPanel
