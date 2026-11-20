// 连接器目录：本地内置精选清单 + 可选远程索引。
//
// 交互口径（面向新手）：
//  · 每张卡先讲「能做什么」，再讲「权限说明」，最后才露出命令；
//  · 点「安装并连接」时把真正要跑的命令摊开确认（SEC-2 不放松）；
//  · 安装后立即连接；失败给一句人话 + 重试入口；
//  · 高危工具不会被目录安装自动授权，仍由能力中心逐工具勾选。
import React, { useCallback, useEffect, useState } from 'react'
import type {
  McpServerRecord,
  McpServerRuntime,
  McpServerStatusEvent
} from '../../../../../shared/types'
import {
  instantiateMcpTemplate,
  type McpTemplate
} from '../../../../../shared/mcp-templates'
import type { McpCatalogEntry, McpCatalogRisk, McpCatalogView } from '../../../../../shared/mcp-catalog'
import { useI18n } from '../../../i18n'
import { useToast } from '../../../components/ToastProvider'
import { useConfirm } from '../../../components/ConfirmDialog'
import { StatusDot, MiniBtn } from '../ui'
import { formatMcpLaunch } from './mcp-launch'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

interface Props {
  onClose: () => void
  /** 安装/连接/重试后通知面板刷新列表 */
  onChanged: () => Promise<void> | void
}

function riskLabelKey(risk: McpCatalogRisk): string {
  if (risk === 'high') return 'agent.catalogRiskHigh'
  if (risk === 'medium') return 'agent.catalogRiskMedium'
  return 'agent.catalogRiskLow'
}

function riskTone(risk: McpCatalogRisk): string {
  if (risk === 'high') return 'text-[var(--color-danger)] bg-[var(--color-danger-bg)]'
  if (risk === 'medium') return 'text-[var(--color-warning)] bg-[var(--color-warning-bg)]'
  return 'text-[var(--color-success)] bg-[var(--color-success-bg)]'
}

/** 目录条目 → 可被 instantiateMcpTemplate 复用的最小形状（占位符替换逻辑与模板共用） */
function asTemplate(entry: McpCatalogEntry): McpTemplate {
  return {
    id: entry.id,
    desc: entry.summary,
    category: entry.category,
    draft: entry.draft,
    ...(entry.placeholders ? { placeholders: entry.placeholders } : {})
  }
}

export const McpCatalogModal: React.FC<Props> = ({ onClose, onChanged }) => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm: askConfirm, dialog: confirmDialog } = useConfirm()

  const [catalog, setCatalog] = useState<McpCatalogView | null>(null)
  const [loadError, setLoadError] = useState('')
  const [records, setRecords] = useState<McpServerRecord[]>([])
  const [runtimes, setRuntimes] = useState<McpServerRuntime[]>([])
  const [values, setValues] = useState<Record<string, Record<string, string>>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const [entryErrors, setEntryErrors] = useState<Record<string, string>>({})
  const [remoteUrl, setRemoteUrl] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [remoteNotice, setRemoteNotice] = useState('')

  const loadCatalog = useCallback(async () => {
    try {
      const r = await window.pocketai.listMcpCatalog()
      if (hasIpcFailed(r)) {
        setLoadError(ipcFailText(r, t('common.unknownError')))
        return
      }
      setLoadError('')
      setCatalog(r)
      setRemoteUrl((prev) => prev || r.indexUrl || '')
    } catch (e) {
      setLoadError(errText(e, t('common.unknownError')))
      logIpcError('mcp.catalogList', e)
    }
  }, [t])

  const loadRecords = useCallback(async () => {
    const [recs, runs] = await Promise.all([
      window.pocketai.listMcpServers(),
      window.pocketai.getMcpRuntimes()
    ])
    if (!hasIpcFailed(recs) && Array.isArray(recs)) setRecords(recs)
    if (!hasIpcFailed(runs) && Array.isArray(runs)) setRuntimes(runs)
  }, [])

  useEffect(() => {
    void loadCatalog()
    void loadRecords().catch(reportIpcError('mcp.catalogRecords'))
  }, [loadCatalog, loadRecords])

  useEffect(() => {
    const off = window.pocketai.onMcpStatus((evt: McpServerStatusEvent) => {
      setRuntimes((prev) => {
        const idx = prev.findIndex((r) => r.id === evt.serverId)
        if (idx === -1) {
          const base = records.find((r) => r.id === evt.serverId)
          if (!base) return prev
          return [
            ...prev,
            {
              ...base,
              status: evt.status,
              tools: evt.tools ?? [],
              toolsTotal: evt.toolsTotal ?? 0,
              toolsHeldBack: evt.toolsHeldBack ?? 0,
              lastError: evt.lastError ?? null,
              pid: evt.pid
            }
          ]
        }
        const next = [...prev]
        next[idx] = {
          ...next[idx]!,
          status: evt.status,
          tools: evt.tools ?? next[idx]!.tools,
          toolsTotal: evt.toolsTotal ?? next[idx]!.toolsTotal,
          toolsHeldBack: evt.toolsHeldBack ?? next[idx]!.toolsHeldBack,
          lastError: evt.lastError ?? null,
          pid: evt.pid
        }
        return next
      })
    })
    return off
  }, [records])

  const recordForEntry = (entry: McpCatalogEntry): McpServerRecord | undefined =>
    records.find((r) => r.catalogId === entry.id) ??
    records.find((r) => r.name === entry.name)

  const runtimeForEntry = (entry: McpCatalogEntry): McpServerRuntime | undefined => {
    const rec = recordForEntry(entry)
    return rec ? runtimes.find((r) => r.id === rec.id) : undefined
  }

  const setValue = (entryId: string, key: string, v: string) => {
    setValues((prev) => ({ ...prev, [entryId]: { ...prev[entryId], [key]: v } }))
  }

  /** 安装后连接（Python 依赖先装好，否则 start 会得到「依赖尚未安装」） */
  const connectRecord = async (rec: McpServerRecord): Promise<string | null> => {
    if (rec.runtime === 'python' && (rec.pythonPackages ?? []).length > 0) {
      const env = await window.pocketai.installPythonEnv(rec.id)
      if (hasIpcFailed(env)) {
        return env.error ?? t('common.unknownError')
      }
    }
    const started = await window.pocketai.startMcpServer(rec.id)
    if (hasIpcFailed(started) || !started.ok) {
      return started.error ?? t('common.unknownError')
    }
    return null
  }

  const handleInstall = async (entry: McpCatalogEntry) => {
    for (const p of entry.placeholders ?? []) {
      if (!String(values[entry.id]?.[p.key] ?? '').trim()) {
        toast.error(t('agent.catalogNeedValue', { label: t(p.label) }))
        return
      }
    }
    const inst = instantiateMcpTemplate(asTemplate(entry), values[entry.id] ?? {})
    if (inst.error || !inst.draft) {
      toast.error(t('common.unknownError'))
      return
    }
    const cmd = formatMcpLaunch(inst.draft)
    const ok = await askConfirm({
      title: t('agent.catalogInstall'),
      message: t('agent.catalogInstallConfirm', { name: entry.title, cmd }),
      danger: entry.risk === 'high'
    })
    if (!ok) return

    setBusyId(entry.id)
    setEntryErrors((prev) => ({ ...prev, [entry.id]: '' }))
    try {
      const saved = await window.pocketai.saveMcpServer({
        ...inst.draft,
        autoConnect: true,
        catalogId: entry.id
      })
      if ('ok' in saved) {
        setEntryErrors((prev) => ({ ...prev, [entry.id]: saved.error }))
        toast.error(saved.error)
        return
      }
      setRecords((prev) => [...prev.filter((r) => r.id !== saved.id), saved])
      const err = await connectRecord(saved)
      if (err) {
        setEntryErrors((prev) => ({ ...prev, [entry.id]: err }))
        toast.error(t('agent.catalogStartFailed', { msg: err }))
      } else {
        toast.success(t('agent.catalogConnected'))
      }
      await onChanged()
      await loadRecords()
    } catch (e) {
      const msg = errText(e, t('common.unknownError'))
      setEntryErrors((prev) => ({ ...prev, [entry.id]: msg }))
      toast.error(t('agent.catalogStartFailed', { msg }))
    } finally {
      setBusyId(null)
    }
  }

  const handleRetry = async (entry: McpCatalogEntry) => {
    const rec = recordForEntry(entry)
    if (!rec) {
      toast.error(t('common.unknownError'))
      return
    }
    setBusyId(entry.id)
    setEntryErrors((prev) => ({ ...prev, [entry.id]: '' }))
    try {
      const err = await connectRecord(rec)
      if (err) {
        setEntryErrors((prev) => ({ ...prev, [entry.id]: err }))
        toast.error(t('agent.catalogStartFailed', { msg: err }))
      } else {
        toast.success(t('agent.catalogConnected'))
      }
      await loadRecords()
    } finally {
      setBusyId(null)
    }
  }

  const handleRefreshRemote = async () => {
    setRefreshing(true)
    setRemoteNotice('')
    try {
      const r = await window.pocketai.refreshMcpCatalog(remoteUrl.trim() || null)
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      setCatalog(r.catalog)
      setRemoteNotice(t('agent.catalogRemoteUpdated', { n: r.catalog.remoteCount }))
      toast.success(t('agent.catalogRemoteUpdated', { n: r.catalog.remoteCount }))
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
      logIpcError('mcp.catalogRefresh', e)
    } finally {
      setRefreshing(false)
    }
  }

  const handleResetRemote = async () => {
    try {
      const r = await window.pocketai.resetMcpCatalog()
      if (hasIpcFailed(r)) {
        toast.error(ipcFailText(r, t('common.unknownError')))
        return
      }
      setCatalog(r.catalog)
      setRemoteNotice('')
      setRemoteUrl('')
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
      logIpcError('mcp.catalogReset', e)
    }
  }

  const entries = catalog?.entries ?? []

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-[760px] max-w-[95vw] max-h-[90vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-[var(--color-border)] flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold">{t('agent.catalogTitle')}</h3>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-1">{t('agent.catalogHint')}</p>
          </div>
          <button className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-3">
          {loadError && (
            <div className="flex items-center gap-2 text-xs text-[var(--color-danger)]">
              <span>{t('agent.catalogLoadFailed', { msg: loadError })}</span>
              <button className="underline" onClick={() => void loadCatalog()}>
                {t('agent.retryConnect')}
              </button>
            </div>
          )}
          {!loadError && entries.length === 0 && (
            <p className="text-xs text-[var(--color-text-muted)]">{t('agent.catalogEmpty')}</p>
          )}

          <div className="grid grid-cols-1 gap-2">
            {entries.map((entry) => {
              const rec = recordForEntry(entry)
              const rt = runtimeForEntry(entry)
              const busy = busyId === entry.id
              const status = rt?.status ?? 'stopped'
              const connected = !!rec && status === 'running'
              const inst = instantiateMcpTemplate(asTemplate(entry), values[entry.id] ?? {})
              const preview = formatMcpLaunch(inst.draft ?? entry.draft)
              const err = entryErrors[entry.id] || (rec && status === 'error' ? rt?.lastError : null)
              return (
                <div
                  key={entry.id}
                  className="rounded border border-[var(--color-border)] p-3 space-y-2"
                >
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-semibold">{entry.title}</span>
                        <span className="text-[9px] px-1 rounded bg-[var(--color-bg-secondary)] text-[var(--color-text-muted)]">
                          {entry.name}
                        </span>
                        {entry.source === 'remote' && (
                          <span className="text-[9px] px-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)]">
                            {t('agent.catalogRemote')}
                          </span>
                        )}
                        <span className={`text-[9px] px-1 rounded ${riskTone(entry.risk)}`}>
                          {t(riskLabelKey(entry.risk))}
                        </span>
                        {rec?.autoConnect && (
                          <span className="text-[9px] px-1 rounded bg-[var(--color-accent-soft)] text-[var(--color-accent)]">
                            {t('agent.autoConnectBadge')}
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-[var(--color-text-muted)] mt-1 leading-relaxed">
                        {entry.summary}
                      </p>
                    </div>
                    {rec && <StatusDot status={status} />}
                  </div>

                  <div>
                    <p className="text-[10px] font-semibold text-[var(--color-text-muted)] mb-0.5">
                      {t('agent.catalogCapabilities')}
                    </p>
                    <ul className="text-[11px] leading-relaxed list-disc pl-4">
                      {entry.capabilities.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </div>

                  <div className="rounded bg-[var(--color-bg-secondary)] px-2 py-1.5">
                    <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                      <span className="font-semibold">{t('agent.catalogPermission')}：</span>
                      {entry.permissionNote}
                    </p>
                    {entry.risk !== 'low' && (
                      <p className="text-[10px] text-[var(--color-warning)] leading-relaxed mt-1">
                        {t('agent.catalogRiskHint')}
                      </p>
                    )}
                  </div>

                  {(entry.placeholders ?? []).map((p) => (
                    <div key={p.key} className="space-y-0.5">
                      <label className="block text-[10px] font-medium text-[var(--color-text-muted)]">
                        {t(p.label)}
                      </label>
                      <input
                        className="input font-mono text-[11px] py-1"
                        type={p.secret ? 'password' : 'text'}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!!rec || busy}
                        value={values[entry.id]?.[p.key] ?? ''}
                        onChange={(e) => setValue(entry.id, p.key, e.target.value)}
                      />
                      {p.secret && (
                        <p className="text-[10px] text-[var(--color-text-muted)]">
                          {t('agent.tplSecretHint')}
                        </p>
                      )}
                    </div>
                  ))}

                  <p className="text-[10px] font-mono text-[var(--color-text-muted)] break-all">
                    {t('agent.catalogCommand', { cmd: preview })}
                  </p>

                  {err && (
                    <div className="text-[11px] text-[var(--color-danger)] bg-[var(--color-danger-bg)] px-2 py-1.5 rounded">
                      {t('agent.catalogStartFailed', { msg: err })}
                    </div>
                  )}

                  <div className="flex items-center gap-1.5">
                    {!rec ? (
                      <button
                        className="btn-primary text-[11px] py-1 px-3"
                        disabled={busy}
                        onClick={() => void handleInstall(entry)}
                      >
                        {busy ? t('agent.catalogInstalling') : t('agent.catalogInstall')}
                      </button>
                    ) : connected ? (
                      <span className="text-[11px] text-[var(--color-success)]">
                        ✓ {t('agent.catalogConnected')}
                      </span>
                    ) : (
                      <>
                        <span className="text-[11px] text-[var(--color-text-muted)]">
                          {t('agent.catalogInstalled')}
                        </span>
                        <MiniBtn disabled={busy || status === 'starting'} onClick={() => void handleRetry(entry)}>
                          {busy || status === 'starting' ? t('common.starting') : t('agent.catalogRetry')}
                        </MiniBtn>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <details className="rounded border border-[var(--color-border)] p-2">
            <summary className="text-[11px] font-medium cursor-pointer text-[var(--color-text-muted)]">
              {t('agent.catalogRemote')}
            </summary>
            <div className="mt-2 space-y-1.5">
              <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">
                {t('agent.catalogRemoteHint')}
              </p>
              <div className="flex gap-1">
                <input
                  className="input font-mono text-[11px] py-1 flex-1 min-w-0"
                  value={remoteUrl}
                  onChange={(e) => setRemoteUrl(e.target.value)}
                  placeholder={t('agent.catalogRemotePh')}
                  spellCheck={false}
                />
                <button
                  className="btn-ghost text-[11px] py-0.5 px-2 shrink-0"
                  disabled={refreshing}
                  onClick={() => void handleRefreshRemote()}
                >
                  {refreshing ? t('agent.catalogRefreshing') : t('agent.catalogRefresh')}
                </button>
                <button
                  className="btn-ghost text-[11px] py-0.5 px-2 shrink-0"
                  onClick={() => void handleResetRemote()}
                >
                  {t('agent.catalogReset')}
                </button>
              </div>
              {remoteNotice && <p className="text-[10px] text-[var(--color-success)]">{remoteNotice}</p>}
              {catalog && catalog.remoteCount > 0 && (
                <p className="text-[10px] text-[var(--color-text-muted)]">
                  {catalog.remoteCount} / {catalog.builtinCount}
                </p>
              )}
            </div>
          </details>
        </div>

        <div className="p-4 border-t border-[var(--color-border)] flex justify-end">
          <button className="btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>
      </div>
      {confirmDialog}
    </div>
  )
}
