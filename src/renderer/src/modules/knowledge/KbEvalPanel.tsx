// 检索评测集面板：选一份「问题 → 期望命中」的卷子，逐条跑真检索，把 recall@k / MRR / 漏召回列出来。
//
// 存在的意义：阈值调到多少、topN 够不够，以前只能靠感觉；判分逻辑（`shared/kb-eval.ts`）
// 与运行器（`main/knowledge/kb-eval-runner.ts`）都已经在了，缺的就是这一屏。
// 三条口径跟着面板一起说清：跑的是**这个库**的检索（含它自己的 topK 与相似度阈值）、
// 一题一次真检索（慢是设计如此）、以及**卷子坏了的时候分数不能单独看**（失效/停用与指标同屏）。
import React, { useState } from 'react'
import { useI18n } from '../../i18n'
import { errText } from '../../utils/error'
import type { KbEvalRunResult } from '../../../../shared/kb-eval'

/** k 输入框的钳位区间，与主进程 schema 同值 */
const K_MIN = 1
const K_MAX = 50

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`

export const KbEvalPanel: React.FC<{ kbId: string }> = ({ kbId }) => {
  const { t } = useI18n()
  const [file, setFile] = useState<{ token: string; fileName: string } | null>(null)
  const [kText, setKText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<KbEvalRunResult | null>(null)

  const pick = async () => {
    setBusy(true)
    try {
      const r = await window.pocketai.pickKbEvalSet()
      if (!r) return // 用户取消：不清掉已有结果，也不报错
      setFile(r)
      setError('')
    } catch (e) {
      setError(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const run = async () => {
    if (!file) return
    setBusy(true)
    setError('')
    try {
      const raw = kText.trim()
      // 只在用户确实填了个数时传 k；空值要让主进程去用这个库自己的 topN
      const k = raw === '' ? undefined : Math.min(K_MAX, Math.max(K_MIN, Number(raw) || K_MIN))
      setResult(await window.pocketai.runKbEval(kbId, file.token, k))
    } catch (e) {
      setError(errText(e))
      setResult(null)
    } finally {
      setBusy(false)
    }
  }

  const m = result?.metrics

  return (
    <div className="mt-4 rounded border border-[var(--color-border)] px-3 py-2.5 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold">{t('kb.evalTitle')}</h4>
        <div className="flex items-center gap-1.5">
          <label className="text-[11px] text-[var(--color-text-muted)]" htmlFor={`kb-eval-k-${kbId}`}>
            {t('kb.evalK')}
          </label>
          <input
            id={`kb-eval-k-${kbId}`}
            className="input w-16 text-xs"
            value={kText}
            inputMode="numeric"
            placeholder="topN"
            disabled={busy}
            onChange={(e) => setKText(e.target.value.replace(/[^0-9]/g, ''))}
          />
          <button onClick={() => void pick()} disabled={busy} className="btn-ghost text-xs disabled:opacity-50">
            {t('kb.evalPick')}
          </button>
          <button
            onClick={() => void run()}
            disabled={busy || !file}
            className="btn-accent text-xs disabled:opacity-50"
          >
            {t('kb.evalRun')}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--color-text-muted)]">{t('kb.evalHint')}</p>
      {file && <p className="text-[11px]">{file.fileName}</p>}
      {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}

      {m && (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <span>
              {t('kb.evalRecall').replace('{k}', String(m.k))} <strong>{pct(m.recallAtK)}</strong>
            </span>
            <span>
              {t('kb.evalMrr')} <strong>{m.mrr.toFixed(3)}</strong>
            </span>
            <span>
              {t('kb.evalMedian')}{' '}
              <strong>{m.medianRank === null ? '—' : m.medianRank.toFixed(1)}</strong>
            </span>
            <span className="text-[var(--color-danger)]">{t('kb.evalMissed').replace('{n}', String(m.missedCases))}</span>
            <span className="text-[var(--color-text-muted)]">
              {t('kb.evalCases').replace('{n}', String(m.cases)).replace('{ms}', String(result?.elapsedMs ?? 0))}
            </span>
          </div>

          {(result?.warnings.length ?? 0) > 0 && (
            <ul className="text-[11px] text-[var(--color-warning)] list-disc pl-4 space-y-0.5">
              {result?.warnings.map((w, i) => (
                <li key={`w${i}`}>{w}</li>
              ))}
            </ul>
          )}

          {(result?.stale.length ?? 0) > 0 && (
            <p className="text-[11px] text-[var(--color-danger)]">
              {t('kb.evalStale').replace('{n}', String(result?.stale.length ?? 0))}
              {result?.stale
                .slice(0, 3)
                .map((s) => ` ${s.caseId}→${s.docId}`)
                .join('；')}
            </p>
          )}

          {(result?.disabledTargets.length ?? 0) > 0 && (
            <p className="text-[11px] text-[var(--color-text-muted)]">
              {t('kb.evalDisabled').replace('{n}', String(result?.disabledTargets.length ?? 0))}
            </p>
          )}

          <ul className="space-y-1">
            {result?.rows.map((r) => (
              <li key={r.caseId} className="text-[11px] leading-tight">
                <span className="font-medium">{r.caseId}</span>
                <span className="ml-1.5">{pct(r.recallAtK)}</span>
                <span className="ml-1.5 text-[var(--color-text-muted)]">
                  {r.firstRank === null ? '—' : `#${r.firstRank}`}
                </span>
                <div className="truncate text-[var(--color-text-muted)]">{r.query}</div>
                {r.missing.length > 0 && (
                  <div>
                    {t('kb.evalMissing')}：
                    {r.missing.map((x) => (x.seq === undefined ? x.docId : `${x.docId}#${x.seq}`)).join('、')}
                  </div>
                )}
                <div className="truncate">
                  {t('kb.evalReturned')}：
                  {r.returned.map((x) => `${x.title || x.docId}(${x.seq})`).join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

export default KbEvalPanel
