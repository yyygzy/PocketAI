// 本机判据屏（V4-Iter-146）：把 140–145 那套判据**原样**摊给用户看
//
// 这块屏的存在理由只有一条：判据的取值分"实测得来"和"没实测所以保守"两种，
// 把它们画成同一种"看起来是事实"的数，用户就会把默认当承诺（方案 §140 立的纪律）。所以：
//  · 每行后面必带一个来源档徽标（测得 / 未实测档的保守默认 / 这次没读到），文案由**码**出，不按值猜；
//  · 界面上出现的数字全部来自主进程送来的报告，**这里不做任何计算**——
//    尤其不做"总显存减一减还能放几台"那种算术（140 的实测把这条算术证伪过：2.7GiB < 4GiB 仍被逐）；
//  · 显存实占是**这一刻**的读数 ⇒ 顶部显示采集时刻，并写明它不参与判据（用户 2026-10-16 选定）。
import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { hasIpcFailed, ipcFailText } from '../../utils/ipc'
import {
  buildLocalJudgementRows,
  type JudgementRow,
  type JudgementSourceCode,
  type LocalJudgementReport
} from '../../../../shared/local-judgement'

const SOURCE_KEY: Record<JudgementSourceCode, string> = {
  measured: 'judgement.source.measured',
  'no-measurement': 'judgement.source.no-measurement',
  unavailable: 'judgement.source.unavailable'
}

/**
 * 配色也按码给，不按值给：**不给绿色**。
 * "绿色 = 已验证可用"是这张屏最不能传达的误导——保守默认档看起来像绿灯，用户就会以为放宽过了。
 */
const SOURCE_TONE: Record<JudgementSourceCode, string> = {
  measured: 'text-[var(--color-text)]',
  'no-measurement': 'text-[var(--color-warning)]',
  unavailable: 'text-[var(--color-text-muted)]'
}

/** 判定取值是动态拼 key 的高危区（102 那轮就是这么漏的）：这里用静态映射，四语字典缺一个 key 用例就会红 */
const CAPABILITY_VALUE_KEY: Record<string, string> = {
  native_tools_ok: 'judgement.value.capability.native_tools_ok',
  fence_only: 'judgement.value.capability.fence_only',
  no_delegation: 'judgement.value.capability.no_delegation',
  unknown: 'judgement.value.capability.unknown'
}

function JudgementRowView({ row }: { row: JudgementRow }): React.JSX.Element {
  const { t } = useI18n()
  const capabilityKey = CAPABILITY_VALUE_KEY[row.valueKey.replace('judgement.value.capability.', '')]
  const valueKey = capabilityKey ?? row.valueKey
  return (
    <div
      className="py-1.5 border-b border-[var(--color-border)] last:border-0"
      data-row-id={row.id}
      // 分组行只报"几个助手相同"，具体是哪几个放在悬停里：不把一屏撑成一列名字
      title={typeof row.params?.names === "string" ? row.params.names : undefined}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-[var(--color-text-muted)] shrink-0">{t(row.labelKey, row.params)}</span>
        <span className="text-xs text-right break-all" data-source={row.sourceCode}>
          {t(valueKey, row.params)}
        </span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={`text-[10px] ${SOURCE_TONE[row.sourceCode]}`} data-source-code={row.sourceCode}>
          {t(SOURCE_KEY[row.sourceCode])}
        </span>
        {row.reasonCodes.map((code) => {
          // 理由码逐字来自判据；字典没这一码时**原样显示码**（比吐出一个 key 字符串更好读，也不会被误当成文案）
          const key = `judgement.reason.${code}`
          const text = t(key)
          return (
            <span key={code} className="text-[10px] opacity-70" data-reason-code={code}>
              {text === key ? code : text}
            </span>
          )
        })}
        {row.noteKey && (
          <span className="text-[10px] text-[var(--color-text-muted)]" data-note-key={row.noteKey}>
            {t(row.noteKey)}
          </span>
        )}
      </div>
    </div>
  )
}

export function LocalJudgementPanel(): React.JSX.Element {
  const { t } = useI18n()
  const [report, setReport] = useState<LocalJudgementReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const v = await window.pocketai.getLocalJudgement()
      // safeHandle 把失败转成**返回值**：不判形状就会把 {ok:false,error} 当报告摊成行（B78 那轮撞到的同族）
      if (hasIpcFailed(v)) {
        setError(ipcFailText(v, t('judgement.loadFail')))
        return
      }
      setReport(v)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="max-w-xl">
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">{t('judgement.intro')}</p>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="text-[11px] px-2 py-1 rounded border border-[var(--color-border)] shrink-0 hover:bg-[var(--color-hover-overlay)] disabled:opacity-50"
        >
          {loading ? t('judgement.refreshing') : t('judgement.refresh')}
        </button>
      </div>

      {error && <div className="text-xs text-[var(--color-danger)] mb-2">{error}</div>}
      {!error && !report && !loading && <div className="text-xs text-[var(--color-text-muted)]">{t('judgement.empty')}</div>}

      {report && (
        <>
          <div className="text-[10px] text-[var(--color-text-muted)] mb-1" data-collected-at={String(report.collectedAt)}>
            {t('judgement.collectedAt', { at: new Date(report.collectedAt).toLocaleTimeString() })}
          </div>
          <div className="text-xs">
            {buildLocalJudgementRows(report).map((r) => (
              <JudgementRowView key={r.id} row={r} />
            ))}
          </div>
          <p className="mt-2 text-[10px] text-[var(--color-text-muted)] leading-relaxed">{t('judgement.footnote')}</p>
        </>
      )}
    </div>
  )
}
