// 远程 MCP OAuth 状态卡（表单内使用）。
//
// 只展示脱敏视图：状态 / 过期时间 / scope / 人话错误；token 永不进入渲染层。
// 授权入口要求已保存的 serverId；首次新建时提示先保存。
import React, { useCallback, useEffect, useState } from 'react'
import type { McpOauthView } from '../../../../../shared/mcp-oauth'
import { useI18n } from '../../../i18n'
import { hasIpcFailed, ipcFailText } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

interface Props {
  serverId?: string
}

function formatTime(ms: number | null): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleString()
  } catch {
    return ''
  }
}

export const McpOauthSection: React.FC<Props> = ({ serverId }) => {
  const { t } = useI18n()
  const [view, setView] = useState<McpOauthView | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [manualOpen, setManualOpen] = useState(false)
  const [authorizationEndpoint, setAuthorizationEndpoint] = useState('')
  const [tokenEndpoint, setTokenEndpoint] = useState('')
  const [registrationEndpoint, setRegistrationEndpoint] = useState('')
  const [scope, setScope] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')

  const load = useCallback(async () => {
    if (!serverId) return
    try {
      const r = await window.pocketai.listMcpOauthViews()
      if (hasIpcFailed(r)) {
        setError(ipcFailText(r, t('common.unknownError')))
        return
      }
      setView((r.views ?? []).find((v) => v.serverId === serverId) ?? null)
    } catch (e) {
      setError(errText(e, t('common.unknownError')))
    }
  }, [serverId, t])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const off = window.pocketai.onMcpOauthStatus((v) => {
      if (!serverId || !v || v.serverId === serverId) {
        setView(v)
        if (v) setPending(false)
      }
    })
    return off
  }, [serverId])

  const begin = async () => {
    if (!serverId) return
    setError('')
    setBusy(true)
    try {
      const r = await window.pocketai.beginMcpOauth(serverId, {
        ...(manualOpen && authorizationEndpoint.trim()
          ? { authorizationEndpoint: authorizationEndpoint.trim() }
          : {}),
        ...(manualOpen && tokenEndpoint.trim() ? { tokenEndpoint: tokenEndpoint.trim() } : {}),
        ...(manualOpen && registrationEndpoint.trim()
          ? { registrationEndpoint: registrationEndpoint.trim() }
          : {}),
        ...(manualOpen && scope.trim() ? { scope: scope.trim() } : {}),
        ...(manualOpen && clientId.trim() ? { clientId: clientId.trim() } : {}),
        ...(manualOpen && clientSecret.trim() ? { clientSecret: clientSecret.trim() } : {})
      })
      if (hasIpcFailed(r)) {
        setError(ipcFailText(r, t('common.unknownError')))
        return
      }
      setPending(true)
    } catch (e) {
      setError(errText(e, t('common.unknownError')))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async () => {
    if (!serverId) return
    setBusy(true)
    setError('')
    try {
      const r = await window.pocketai.cancelMcpOauth(serverId)
      if (hasIpcFailed(r)) {
        setError(ipcFailText(r, t('common.unknownError')))
        return
      }
      setPending(false)
    } catch (e) {
      setError(errText(e, t('common.unknownError')))
    } finally {
      setBusy(false)
    }
  }

  const clear = async () => {
    if (!serverId) return
    setBusy(true)
    setError('')
    try {
      const r = await window.pocketai.clearMcpOauth(serverId)
      if (hasIpcFailed(r)) {
        setError(ipcFailText(r, t('common.unknownError')))
        return
      }
      setView(null)
      setPending(false)
    } catch (e) {
      setError(errText(e, t('common.unknownError')))
    } finally {
      setBusy(false)
    }
  }

  if (!serverId) {
    return (
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-[11px] text-[var(--color-text-muted)]">
        {t('agent.oauthSaveFirst')}
      </div>
    )
  }

  const status = pending ? 'pending' : view?.status ?? 'none'
  const badgeClass =
    status === 'authorized'
      ? 'text-[var(--color-success)] bg-[var(--color-success-bg)]'
      : status === 'needs_reauth' || status === 'error'
        ? 'text-[var(--color-danger)] bg-[var(--color-danger-bg)]'
        : 'text-[var(--color-text-muted)] bg-[var(--color-bg-secondary)]'
  const statusText =
    status === 'authorized'
      ? t('agent.oauthAuthorized')
      : status === 'needs_reauth'
        ? t('agent.oauthNeedsReauth')
        : status === 'error'
          ? t('agent.oauthError')
          : status === 'pending'
            ? t('agent.oauthPending')
            : t('agent.oauthNotAuthorized')

  return (
    <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium">{t('agent.oauthTitle')}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${badgeClass}`}>{statusText}</span>
          {view?.expiresAt ? (
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {t('agent.oauthExpiresAt', { time: formatTime(view.expiresAt) })}
            </span>
          ) : null}
        </div>
        <div className="flex gap-1">
          {status === 'pending' ? (
            <button className="btn-ghost text-[11px] py-0.5 px-2" disabled={busy} onClick={() => void cancel()}>
              {t('agent.oauthCancel')}
            </button>
          ) : (
            <button className="btn-ghost text-[11px] py-0.5 px-2" disabled={busy} onClick={() => void begin()}>
              {view?.status === 'authorized' ? t('agent.oauthReauthorize') : t('agent.oauthAuthorize')}
            </button>
          )}
          {view && (
            <button className="btn-ghost text-[11px] py-0.5 px-2" disabled={busy} onClick={() => void clear()}>
              {t('agent.oauthClear')}
            </button>
          )}
        </div>
      </div>

      <p className="text-[10px] text-[var(--color-text-muted)] leading-relaxed">{t('agent.oauthHint')}</p>
      {view?.scope && (
        <p className="text-[10px] text-[var(--color-text-muted)] break-all">
          {t('agent.oauthScope', { scope: view.scope })}
        </p>
      )}
      {error && <p className="text-[11px] text-[var(--color-danger)]">{error}</p>}
      {!error && view?.lastError && <p className="text-[11px] text-[var(--color-danger)]">{view.lastError}</p>}

      <details
        className="text-[11px]"
        open={manualOpen}
        onToggle={(e) => setManualOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="cursor-pointer text-[var(--color-text-muted)]">{t('agent.oauthAdvanced')}</summary>
        <div className="mt-2 space-y-1.5">
          <p className="text-[10px] text-[var(--color-text-muted)]">{t('agent.oauthAdvancedHint')}</p>
          <input
            className="input font-mono text-[11px] py-1"
            placeholder={t('agent.oauthPhAuthEndpoint')}
            value={authorizationEndpoint}
            onChange={(e) => setAuthorizationEndpoint(e.target.value)}
            spellCheck={false}
          />
          <input
            className="input font-mono text-[11px] py-1"
            placeholder={t('agent.oauthPhTokenEndpoint')}
            value={tokenEndpoint}
            onChange={(e) => setTokenEndpoint(e.target.value)}
            spellCheck={false}
          />
          <input
            className="input font-mono text-[11px] py-1"
            placeholder={t('agent.oauthPhRegisterEndpoint')}
            value={registrationEndpoint}
            onChange={(e) => setRegistrationEndpoint(e.target.value)}
            spellCheck={false}
          />
          <input
            className="input text-[11px] py-1"
            placeholder={t('agent.oauthPhScope')}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
          />
          <input
            className="input font-mono text-[11px] py-1"
            placeholder={t('agent.oauthPhClientId')}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            spellCheck={false}
          />
          <input
            type="password"
            autoComplete="off"
            className="input font-mono text-[11px] py-1"
            placeholder={t('agent.oauthPhClientSecret')}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
      </details>
    </div>
  )
}
