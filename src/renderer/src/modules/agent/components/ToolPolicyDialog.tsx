import React, { useCallback, useEffect, useState } from 'react'
import type { ToolPolicyEntry, ToolPolicySnapshot } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

/**
 * 工具策略总览（P0-3a）。
 *
 * 只读：这里**不做任何判定**。每一档的取值都来自主进程 `toolRegistry.policySnapshot()`——
 * 基线来自 `schema.permission`，终端原因码来自 shell-tools 的同一张规则表，MCP 的
 * `needs-explicit` 与 `isToolAllowedBy` 同一口径。渲染端连一条工具名单都不写（测试用合成
 * 快照钉住这一点），避免屏上规则与执行规则各走一套。
 */
export const ToolPolicyDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useI18n()
  const [snapshot, setSnapshot] = useState<ToolPolicySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(() => {
    setLoading(true)
    window.pocketai
      .getToolPolicy()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setError(ipcFailText(v, t('common.unknownError')))
          return
        }
        setError(null)
        setSnapshot(v)
      })
      .catch((e: unknown) => {
        setError(errText(e, t('common.unknownError')))
        logIpcError('toolPolicy.get', e)
      })
      .finally(() => setLoading(false))
  }, [t])

  useEffect(() => {
    load()
  }, [load])

  const decisionLabel = (p: ToolPolicyEntry['permission']) =>
    p === 'confirm' ? t('tp.permission.confirm') : p === 'deny' ? t('tp.permission.deny') : t('tp.permission.auto')

  const stateLabel = (s: ToolPolicyEntry['state']) => {
    switch (s) {
      case 'disabled':
        return t('tp.state.disabled')
      case 'needs-explicit':
        return t('tp.state.needsExplicit')
      case 'denied':
        return t('tp.state.denied')
      default:
        return t('tp.state.available')
    }
  }

  const stateClass = (s: ToolPolicyEntry['state']) => {
    switch (s) {
      case 'disabled':
        return 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
      case 'needs-explicit':
        return 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
      case 'denied':
        return 'bg-red-500/10 text-red-600 dark:text-red-400'
      default:
        return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
    }
  }

  const row = (tool: ToolPolicyEntry) => (
    <div key={tool.id} className="flex items-start gap-3 py-2.5 border-b border-[var(--color-border)] last:border-b-0">
      <div className="w-40 shrink-0 min-w-0">
        <code className="text-[11px] font-mono text-[var(--color-text)] break-all">{tool.name}</code>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]">
            {tool.source === 'mcp' ? t('tp.source.mcp') : t('tp.source.builtin')}
          </span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded ${stateClass(tool.state)}`}>
            {stateLabel(tool.state)}
          </span>
        </div>
      </div>
      <div className="w-24 shrink-0 text-[11px] text-[var(--color-text)]">
        {decisionLabel(tool.permission)}
        {tool.dynamic && (
          <div className="mt-1 text-[9px] text-[var(--color-text-muted)]">{t('tp.dynamic')}</div>
        )}
      </div>
      <div className="flex-1 min-w-0 flex flex-wrap gap-1">
        {tool.reasons.length > 0
          ? tool.reasons.map((code) => (
              <span
                key={code}
                className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
              >
                {t(`tp.reason.${code}`)}
              </span>
            ))
          : tool.dynamic
            ? <span className="text-[10px] text-[var(--color-text-muted)]">{t('tp.shell.rulesHint')}</span>
            : <span className="text-[10px] text-[var(--color-text-muted)]">—</span>}
      </div>
    </div>
  )

  const reasonList = (codes: string[]) => (
    <div className="flex flex-wrap gap-1">
      {codes.map((code) => (
        <span
          key={code}
          className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text)]"
        >
          {t(`tp.reason.${code}`)}
        </span>
      ))}
    </div>
  )

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('tp.title')}
      className="fixed inset-0 z-[60] bg-[var(--color-modal-overlay)] backdrop-blur-sm flex items-center justify-center p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[85vh] flex flex-col rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--color-border)]">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text)]">{t('tp.title')}</h2>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{t('tp.subtitle')}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {t('common.close')}
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3">
          {loading && <p className="text-[11px] text-[var(--color-text-muted)]">{t('common.loading')}</p>}
          {!loading && error && (
            <div className="flex items-center gap-2 text-[11px] text-red-600 dark:text-red-400">
              <span className="flex-1">{t('tp.readFail')}：{error}</span>
              <button type="button" onClick={load} className="shrink-0 underline">
                {t('tp.retry')}
              </button>
            </div>
          )}
          {!loading && snapshot && (
            <>
              <div className="flex items-center gap-3 pb-2 text-[10px] font-medium text-[var(--color-text-muted)]">
                <span className="w-40 shrink-0">{t('tp.col.tool')}</span>
                <span className="w-24 shrink-0">{t('tp.col.decision')}</span>
                <span className="flex-1">{t('tp.col.reason')}</span>
              </div>
              {snapshot.tools.map(row)}

              <div className="mt-4 rounded-xl border border-[var(--color-border)] p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-[12px] font-semibold text-[var(--color-text)]">{t('tp.shell.title')}</h3>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]">
                    {snapshot.shell.enabled ? t('tp.state.available') : t('tp.state.disabled')}
                  </span>
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                    {snapshot.shell.policy === 'confirm'
                      ? t('tp.shell.policyConfirm')
                      : t('tp.shell.policyAutoSafe')}
                  </span>
                </div>
                {!snapshot.shell.enabled && (
                  <p className="mt-1.5 text-[10px] text-[var(--color-text-muted)]">{t('tp.shell.disabledHint')}</p>
                )}
                <div className="mt-2.5">
                  <div className="text-[10px] font-medium text-[var(--color-text)]">{t('tp.shell.denyTitle')}</div>
                  <div className="mt-1">{reasonList(snapshot.shell.denyReasons)}</div>
                </div>
                <div className="mt-2.5">
                  <div className="text-[10px] font-medium text-[var(--color-text)]">{t('tp.shell.confirmTitle')}</div>
                  <div className="mt-1">{reasonList(snapshot.shell.confirmReasons)}</div>
                </div>
              </div>

              <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('tp.mcp.note')}</p>
              <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('tp.readonlyNote')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
