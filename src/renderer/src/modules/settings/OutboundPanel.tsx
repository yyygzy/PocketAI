// 出网清单 + v2 全局 allowlist。
//
// 清单来自主进程 net/outbound-registry.ts（覆盖测试盯住调用点）；策略由
// net/outbound-policy.ts 落在 app_config，默认关闭，开启后经 safeFetch 的所有请求 fail-closed。
import React, { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import type {
  OutboundEntryView,
  OutboundKind,
  OutboundSitePolicyView,
  OutboundTransport
} from '../../../../shared/types'

interface PolicyDraft {
  enabled: boolean
  hosts: string
}

export const OutboundPanel: React.FC = () => {
  const { t } = useI18n()
  const [entries, setEntries] = useState<OutboundEntryView[] | null>(null)
  const [err, setErr] = useState('')
  const [policy, setPolicy] = useState<OutboundSitePolicyView | null>(null)
  const [draft, setDraft] = useState<PolicyDraft>({ enabled: false, hosts: '' })
  const [policyErr, setPolicyErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    let alive = true
    window.pocketai
      .getOutboundEntries()
      .then((r) => {
        if (!alive) return
        if (hasIpcFailed(r)) {
          const msg = ipcFailText(r, t('common.unknownError'))
          setErr(msg)
          logIpcError('settings.getOutboundEntries', new Error(msg))
          return
        }
        setEntries(r)
      })
      .catch((e) => {
        if (!alive) return
        setErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getOutboundEntries', e)
      })

    window.pocketai
      .getOutboundPolicy()
      .then((r) => {
        if (!alive) return
        if (hasIpcFailed(r)) {
          setPolicyErr(ipcFailText(r, t('common.unknownError')))
          return
        }
        setPolicy(r)
        setDraft({ enabled: r.enabled, hosts: r.allowedHosts.join('\n') })
      })
      .catch((e) => {
        if (!alive) return
        setPolicyErr(errText(e, t('common.unknownError')))
        logIpcError('settings.getOutboundPolicy', e)
      })
    return () => {
      alive = false
    }
  }, [t])

  const savePolicy = async (): Promise<void> => {
    setSaving(true)
    setPolicyErr('')
    setSaved(false)
    try {
      const hosts = draft.hosts
        .split(/[\r\n,]/)
        .map((h) => h.trim())
        .filter((h) => h.length > 0)
      const r = await window.pocketai.setOutboundPolicy({ enabled: draft.enabled, allowedHosts: hosts })
      if (hasIpcFailed(r)) {
        setPolicyErr(ipcFailText(r, t('common.unknownError')))
        return
      }
      setPolicy(r)
      setDraft({ enabled: r.enabled, hosts: r.allowedHosts.join('\n') })
      setSaved(true)
    } catch (e) {
      setPolicyErr(errText(e, t('common.unknownError')))
      logIpcError('settings.setOutboundPolicy', e)
    } finally {
      setSaving(false)
    }
  }

  if (err) return <LoadFailNotice msg={err} />
  if (!entries) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }

  const hasRuntime = entries.some((e) => e.kind === 'runtime-url')

  // kind / transport 的文案写成字面量 key（原来 `outbound.kind.${...}` 是动态拼接）：
  // 联合类型加了新成员而这里没补文案时，`satisfies Record<...>` 直接编译红，不靠运行期撞。
  const kindText = {
    fixed: t('outbound.kind.fixed'),
    configurable: t('outbound.kind.configurable'),
    'runtime-url': t('outbound.kind.runtime-url'),
    'local-loopback': t('outbound.kind.local-loopback')
  } satisfies Record<OutboundKind, string>
  const transportText = {
    safeFetch: t('outbound.transport.safeFetch'),
    fetch: t('outbound.transport.fetch'),
    webdav: t('outbound.transport.webdav'),
    updater: t('outbound.transport.updater'),
    websocket: t('outbound.transport.websocket'),
    'child-process': t('outbound.transport.child-process')
  } satisfies Record<OutboundTransport, string>

  return (
    <div className="space-y-3 text-xs">
      <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('outbound.hint')}</p>
      {hasRuntime && (
        <p className="text-[10px] leading-relaxed text-[var(--color-warning)]">{t('outbound.runtimeNotice')}</p>
      )}

      <div className="space-y-2 rounded-lg border border-[var(--color-border)] p-3">
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              data-testid="outbound-policy-enabled"
              checked={draft.enabled}
              onChange={(e) => {
                setDraft((d) => ({ ...d, enabled: e.target.checked }))
                setSaved(false)
              }}
            />
            <span className="font-medium text-[var(--color-text)]">{t('outbound.policyEnable')}</span>
          </label>
          <button
            type="button"
            data-testid="outbound-policy-save"
            disabled={saving}
            onClick={() => void savePolicy()}
            className="ml-auto px-2 py-0.5 rounded border border-[var(--color-accent)] text-[var(--color-accent)] disabled:opacity-50"
          >
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
        <textarea
          data-testid="outbound-policy-hosts"
          value={draft.hosts}
          onChange={(e) => {
            setDraft((d) => ({ ...d, hosts: e.target.value }))
            setSaved(false)
          }}
          rows={3}
          placeholder="api.example.com\nlocalhost"
          className="w-full rounded border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-2 py-1 font-mono text-[11px]"
        />
        <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('outbound.policyHint')}</p>
        {draft.enabled && draft.hosts.trim() === '' && (
          <p className="text-[10px] text-[var(--color-danger)]">{t('outbound.policyEmptyNotice')}</p>
        )}
        {policyErr && (
          <p data-testid="outbound-policy-error" className="text-[11px] text-[var(--color-danger)]">
            {policyErr}
          </p>
        )}
        {saved && (
          <p data-testid="outbound-policy-saved" className="text-[11px] text-[var(--color-success)]">
            {t('outbound.policySaved')}
          </p>
        )}
        {policy && !policy.enabled && (
          <p className="text-[10px] text-[var(--color-text-muted)]">{t('outbound.policyDefaultOff')}</p>
        )}
      </div>

      {entries.length === 0 ? (
        <div className="text-xs text-[var(--color-text-muted)]">{t('outbound.empty')}</div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-[var(--color-border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-[var(--color-hover-overlay)] text-[var(--color-text-muted)]">
                <th className="text-left px-3 py-2 font-medium">{t('outbound.col.category')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('outbound.col.address')}</th>
                <th className="text-left px-3 py-2 font-medium w-28">{t('outbound.col.kind')}</th>
                <th className="text-left px-3 py-2 font-medium">{t('outbound.col.purpose')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id} className="border-t border-[var(--color-border)] align-top">
                  <td className="px-3 py-2 text-[var(--color-text)]">{t(e.labelKey)}</td>
                  <td className="px-3 py-2 font-mono text-[var(--color-text-muted)] break-all">
                    {e.resolveError ? (
                      <span className="text-[var(--color-danger)]">
                        {t('outbound.resolveFailed', { error: e.resolveError })}
                      </span>
                    ) : e.addresses.length > 0 ? (
                      e.addresses.map((a, i) => (
                        <div key={`${a.value}-${i}`}>
                          {a.label ? `${a.label} · ` : ''}
                          {a.value}
                        </div>
                      ))
                    ) : e.kind === 'runtime-url' ? (
                      <span>{t('outbound.runtimeNotice')}</span>
                    ) : (
                      <span>{t('outbound.notConfigured')}</span>
                    )}
                    {e.transport === 'child-process' && (
                      <div className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">
                        {t('outbound.childProcess')}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {kindText[e.kind]}
                    {e.kind === 'local-loopback' && (
                      <div className="mt-0.5 text-[10px] text-[var(--color-success)]">{t('outbound.localOnly')}</div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    <div>{t(e.purposeKey)}</div>
                    <div className="mt-0.5 text-[10px] font-mono break-all">
                      {transportText[e.transport]}
                      {e.configSource ? ` · ${e.configSource}` : ''}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
