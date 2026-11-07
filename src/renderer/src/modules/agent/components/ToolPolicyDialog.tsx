import React, { useCallback, useEffect, useState } from 'react'
import type { ToolPolicyEntry, ToolPolicySnapshot } from '../../../../../shared/types'
import type { ToolPolicyReasonCode } from '../../../../../shared/tool-policy-reasons'
import { useI18n } from '../../../i18n'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

/**
 * 工具策略总览（P0-3a／P0-3c）。
 *
 * 只读：这里**不做任何判定**。每一档的取值都来自主进程 `toolRegistry.policySnapshot(assistant)`——
 * 注册表全量来自 `schema.permission`，当前助手视角的「是否授权」来自 `isToolAllowedBy`，
 * 终端原因码来自 shell-tools 的同一张规则表。渲染端连一条工具名单都不写（测试用合成快照钉住这一点）。
 *
 * 两视角：默认落在「当前助手」——这颗入口在输入区工具菜单里，用户问的是「这个助手到底能用什么」；
 * 「注册表全量」作为对照随时可切。
 */
export const ToolPolicyDialog: React.FC<{ assistantId?: string; onClose: () => void }> = ({
  assistantId,
  onClose
}) => {
  const { t } = useI18n()
  // 29 颗原因码 ↔ i18n 的 tp.reason.*：字面量表钉住完整性（漏一颗 typecheck 就红，不再运行时拼 key）
  const reasonText = {
    BLOCKED_FORMAT: t('tp.reason.BLOCKED_FORMAT'),
    BLOCKED_DISKPART: t('tp.reason.BLOCKED_DISKPART'),
    BLOCKED_MKFS: t('tp.reason.BLOCKED_MKFS'),
    BLOCKED_SHUTDOWN: t('tp.reason.BLOCKED_SHUTDOWN'),
    BLOCKED_BOOTCFG: t('tp.reason.BLOCKED_BOOTCFG'),
    BLOCKED_CIPHER_WIPE: t('tp.reason.BLOCKED_CIPHER_WIPE'),
    BLOCKED_REG_HIVE: t('tp.reason.BLOCKED_REG_HIVE'),
    BLOCKED_SYSTEM_DELETE: t('tp.reason.BLOCKED_SYSTEM_DELETE'),
    BLOCKED_FORKBOMB: t('tp.reason.BLOCKED_FORKBOMB'),
    BLOCKED_ROOT_DELETE: t('tp.reason.BLOCKED_ROOT_DELETE'),
    DANGEROUS_DELETE: t('tp.reason.DANGEROUS_DELETE'),
    DANGEROUS_OVERWRITE: t('tp.reason.DANGEROUS_OVERWRITE'),
    DANGEROUS_WRITE: t('tp.reason.DANGEROUS_WRITE'),
    DANGEROUS_KILL: t('tp.reason.DANGEROUS_KILL'),
    DANGEROUS_PERMISSION: t('tp.reason.DANGEROUS_PERMISSION'),
    DANGEROUS_ACCOUNT: t('tp.reason.DANGEROUS_ACCOUNT'),
    DANGEROUS_REGISTRY: t('tp.reason.DANGEROUS_REGISTRY'),
    DANGEROUS_PUBLISH: t('tp.reason.DANGEROUS_PUBLISH'),
    DANGEROUS_PIPE_EXEC: t('tp.reason.DANGEROUS_PIPE_EXEC'),
    DANGEROUS_ENCODED: t('tp.reason.DANGEROUS_ENCODED'),
    DANGEROUS_INTERPRETER_INLINE: t('tp.reason.DANGEROUS_INTERPRETER_INLINE'),
    DANGEROUS_EXEC_HOST: t('tp.reason.DANGEROUS_EXEC_HOST'),
    DANGEROUS_PERSISTENCE: t('tp.reason.DANGEROUS_PERSISTENCE'),
    DANGEROUS_DOWNLOAD_WRITE: t('tp.reason.DANGEROUS_DOWNLOAD_WRITE'),
    DANGEROUS_PRIVILEGE: t('tp.reason.DANGEROUS_PRIVILEGE'),
    DANGEROUS_TRAVERSAL: t('tp.reason.DANGEROUS_TRAVERSAL'),
    DANGEROUS_OUTSIDE: t('tp.reason.DANGEROUS_OUTSIDE'),
    REQUIRES_CONFIRM: t('tp.reason.REQUIRES_CONFIRM'),
    WRITES_WORKSPACE_FILE: t('tp.reason.WRITES_WORKSPACE_FILE')
  } satisfies Record<ToolPolicyReasonCode, string>
  // 快照里的码按主进程同一张规则表来；万一未来漂出一个表外码，原样显示码本身（不再拼 i18n key）
  const reasonTextOf = (code: string): string =>
    code in reasonText ? reasonText[code as ToolPolicyReasonCode] : code
  const [snapshot, setSnapshot] = useState<ToolPolicySnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [scope, setScope] = useState<'assistant' | 'registry'>('assistant')

  const load = useCallback(() => {
    setLoading(true)
    window.pocketai
      .getToolPolicy(assistantId)
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
  }, [assistantId, t])

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
      case 'not-granted':
        return t('tp.state.notGranted')
      default:
        return t('tp.state.available')
    }
  }

  const stateClass = (s: ToolPolicyEntry['state']) => {
    switch (s) {
      case 'disabled':
        return 'bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]'
      case 'needs-explicit':
      case 'not-granted':
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
                {reasonTextOf(code)}
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
          {reasonTextOf(code)}
        </span>
      ))}
    </div>
  )

  const tableHead = (
    <div className="flex items-center gap-3 pb-2 text-[10px] font-medium text-[var(--color-text-muted)]">
      <span className="w-40 shrink-0">{t('tp.col.tool')}</span>
      <span className="w-24 shrink-0">{t('tp.col.decision')}</span>
      <span className="flex-1">{t('tp.col.reason')}</span>
    </div>
  )

  const assistantView = snapshot?.assistant
  const showAssistant = scope === 'assistant'
  const rows = showAssistant ? (assistantView?.tools ?? []) : (snapshot?.tools ?? [])

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
            <div className="mt-2 flex items-center gap-1" role="tablist">
              <button
                type="button"
                role="tab"
                aria-pressed={showAssistant}
                onClick={() => setScope('assistant')}
                className={`text-[11px] px-2 py-1 rounded border ${
                  showAssistant
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                }`}
              >
                {t('tp.scope.assistant')}
              </button>
              <button
                type="button"
                role="tab"
                aria-pressed={!showAssistant}
                onClick={() => setScope('registry')}
                className={`text-[11px] px-2 py-1 rounded border ${
                  !showAssistant
                    ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                    : 'border-[var(--color-border)] text-[var(--color-text-muted)]'
                }`}
              >
                {t('tp.scope.registry')}
              </button>
            </div>
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
              {showAssistant && !assistantView && (
                <div className="py-4" data-testid="tp-no-assistant">
                  <p className="text-[12px] font-medium text-[var(--color-text)]">{t('tp.effective.noContext')}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
                    {t('tp.effective.noContextHint')}
                  </p>
                </div>
              )}
              {showAssistant && assistantView && (
                <div className="mb-2 rounded-xl border border-[var(--color-border)] px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[12px] font-semibold text-[var(--color-text)]">
                      {t('tp.effective.assistantName', { name: assistantView.name })}
                    </h3>
                    <span className="text-[9px] px-1.5 py-0.5 rounded bg-[var(--color-inline-code-bg)] text-[var(--color-text-muted)]">
                      {assistantView.isBuiltin ? t('tp.effective.builtinBadge') : t('tp.effective.userBadge')}
                    </span>
                  </div>
                  {assistantView.emptyPermissions && (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-red-600 dark:text-red-400">
                      {t('tp.effective.emptyPermissions')}
                    </p>
                  )}
                  {!assistantView.emptyPermissions && assistantView.permissions.includes('*') && (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      {t('tp.effective.starNote')}
                    </p>
                  )}
                  {!assistantView.loadSkillAvailable && (
                    <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                      {t('tp.effective.noLoadSkill')}
                    </p>
                  )}
                  <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                    {t('tp.effective.mcpNote')}
                  </p>
                </div>
              )}
              {snapshot.mcpStoppedServers > 0 && (
                <p className="mb-2 text-[10px] leading-relaxed text-[var(--color-text-muted)]">
                  {t('tp.effective.mcpStopped', { count: snapshot.mcpStoppedServers })}
                </p>
              )}
              {(assistantView || !showAssistant) && (
                <>
                  {tableHead}
                  {rows.map(row)}
                </>
              )}

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

              {!showAssistant && (
                <p className="mt-3 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('tp.mcp.note')}</p>
              )}
              <p className="mt-1.5 text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('tp.readonlyNote')}</p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
