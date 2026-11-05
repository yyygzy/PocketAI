// 出网清单（只读，2c-2）
//
// 数据来自主进程 net/outbound-registry.ts：清单由代码注册表枚举，覆盖测试盯住调用点；
// 当前地址从现有配置仓储解析（不是写死的显示文案）。
// v1 只读：不跳转到对应设置、不做阻断/allowlist/导出。
import React, { useEffect, useState } from 'react'
import { useI18n } from '../../i18n'
import { LoadFailNotice } from '../../components/LoadFailNotice'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import type { OutboundEntryView } from '../../../../shared/types'

export const OutboundPanel: React.FC = () => {
  const { t } = useI18n()
  const [entries, setEntries] = useState<OutboundEntryView[] | null>(null)
  const [err, setErr] = useState('')

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
    return () => {
      alive = false
    }
  }, [])

  if (err) return <LoadFailNotice msg={err} />
  if (!entries) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('common.loading')}</div>
  }
  if (entries.length === 0) {
    return <div className="text-xs text-[var(--color-text-muted)]">{t('outbound.empty')}</div>
  }

  const hasRuntime = entries.some((e) => e.kind === 'runtime-url')

  return (
    <div className="space-y-3 text-xs">
      <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">{t('outbound.hint')}</p>
      {hasRuntime && (
        <p className="text-[10px] leading-relaxed text-[var(--color-warning)]">{t('outbound.runtimeNotice')}</p>
      )}

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
                  {t(`outbound.kind.${e.kind}`)}
                  {e.kind === 'local-loopback' && (
                    <div className="mt-0.5 text-[10px] text-[var(--color-success)]">{t('outbound.localOnly')}</div>
                  )}
                </td>
                <td className="px-3 py-2 text-[var(--color-text-muted)]">
                  <div>{t(e.purposeKey)}</div>
                  <div className="mt-0.5 text-[10px] font-mono break-all">
                    {t(`outbound.transport.${e.transport}`)}
                    {e.configSource ? ` · ${e.configSource}` : ''}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
