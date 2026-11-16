// MCP 站点级出网限制卡片（全局一条，只作用于 HTTP 传输）
//
// 为什么单独一张卡而不是塞进 Server 表单：这是**全局**约束，与单个 Server 的地址无关；
// 而且它的价值有一半在"说清它和另外三套机制的关系"——域名清单（只读声明）、
// 逐工具 confirm（动作授权）、trustReadOnly（降级确认强度）各管一段，这里只管"能连哪个 host"。
import React, { useCallback, useEffect, useState } from 'react'
import type { McpSitePolicy } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { ShowingDefaultsNotice } from '../../../components/ShowingDefaultsNotice'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../../../utils/ipc'
import { errText } from '../../../utils/error'

export const McpSitePolicyCard: React.FC<{ notify: (msg: string) => void }> = ({ notify }) => {
  const { t } = useI18n()
  /** 勾选＝只允许清单内域名（对应 allowOtherHosts=false）；默认不勾＝维持既有行为 */
  const [strict, setStrict] = useState(false)
  const [hostsText, setHostsText] = useState('')
  const [unread, setUnread] = useState<{ error: string } | null>(null)
  const [saveError, setSaveError] = useState('')

  const applyPolicy = useCallback((policy: McpSitePolicy) => {
    setStrict(!policy.allowOtherHosts)
    setHostsText(policy.allowedHosts.join('\n'))
  }, [])

  const reload = useCallback(() => {
    window.pocketai
      .getMcpSitePolicy()
      .then((r) => {
        if (hasIpcFailed(r)) {
          setUnread({ error: ipcFailText(r, t('common.unknownError')) })
          return
        }
        setUnread(null)
        applyPolicy(r)
      })
      .catch(reportIpcError('mcp.getMcpSitePolicy'))
  }, [applyPolicy, t])

  useEffect(() => {
    reload()
  }, [reload])

  const save = async (): Promise<void> => {
    setSaveError('')
    try {
      const r = await window.pocketai.setMcpSitePolicy({
        // 空行不当成条目：用户排版习惯不该变成一条非法 host
        allowedHosts: hostsText
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s !== ''),
        allowOtherHosts: !strict
      })
      if (hasIpcFailed(r)) {
        setSaveError(ipcFailText(r, t('common.unknownError')))
        return
      }
      applyPolicy(r)
      notify(t('agent.mcpSitePolicySaved'))
    } catch (e) {
      logIpcError('mcp.setMcpSitePolicy', e)
      setSaveError(errText(e, t('common.unknownError')))
    }
  }

  return (
    <div className="mb-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 space-y-1.5">
      <label className="block text-[11px] font-medium text-[var(--color-text-muted)]">
        {t('agent.mcpSitePolicyTitle')}
      </label>
      <p className="text-[10px] leading-4 text-[var(--color-text-muted)]">{t('agent.mcpSitePolicyHint')}</p>
      {unread && <ShowingDefaultsNotice what={t('agent.mcpSitePolicyTitle')} msg={unread.error} />}
      <label className="flex items-center gap-1.5 text-[11px]">
        <input type="checkbox" checked={strict} onChange={(e) => setStrict(e.target.checked)} />
        <span>{t('agent.mcpSitePolicyStrict')}</span>
      </label>
      <label className="block text-[11px] text-[var(--color-text-muted)]">
        {t('agent.mcpSitePolicyHosts')}
      </label>
      <textarea
        className="input w-full font-mono text-[11px] py-1"
        rows={3}
        spellCheck={false}
        value={hostsText}
        placeholder={t('agent.mcpSitePolicyHostsPh')}
        onChange={(e) => setHostsText(e.target.value)}
        data-testid="mcp-site-policy-hosts"
      />
      <div className="flex items-center gap-2">
        <button className="btn-ghost text-[11px] py-0.5 px-2 shrink-0" onClick={() => void save()}>
          {t('common.save')}
        </button>
      </div>
      {saveError && (
        <p role="alert" className="text-[10px] leading-4 text-[var(--color-danger)]">
          {t('agent.mcpSitePolicySaveFailed', { msg: saveError })}
        </p>
      )}
      <p className="text-[10px] leading-4 text-[var(--color-text-muted)]">{t('agent.mcpSitePolicyStdio')}</p>
    </div>
  )
}
