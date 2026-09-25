// Agent 工具开关三行：shell 命令策略 / 联网搜索 / 本地日历（可折叠，默认收起省空间）
// 凭据明文仅存主进程，渲染端只拿 hasKey 标记（不回显）
import React, { useState } from 'react'
import type { ShellConfig, WebSearchConfig } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import type { AgentToolConfigs } from '../hooks/useAgentToolConfigs'

export const AgentToolBars: React.FC<{ tools: AgentToolConfigs }> = ({ tools }) => {
  const { t } = useI18n()
  const [expanded, setExpanded] = useState(false)
  const {
    workspaceDir,
    shellConfig,
    wsConfig,
    wsKeyDraft,
    setWsKeyDraft,
    patchShellConfig,
    patchWsConfig,
    patchCalConfig,
    calConfig,
    addIcs
  } = tools

  if (!expanded) {
    // 收起态：单行摘要，点击展开
    const summary = [
      shellConfig.enabled ? '🖥' : null,
      wsConfig.enabled ? '🌐' : null,
      calConfig.enabled ? '📅' : null
    ].filter(Boolean).join(' ') || t('agent.toolConfig')
    return (
      <button
        onClick={() => setExpanded(true)}
        className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1 py-0.5 self-start"
        title={t('agent.expand')}
      >
        <span>▸</span>
        <span>{t('agent.toolConfig')}</span>
        <span className="opacity-70">{summary}</span>
      </button>
    )
  }

  return (
    <>
      <button
        onClick={() => setExpanded(false)}
        className="mt-1 flex items-center gap-2 text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-1 py-0.5 self-start"
        title={t('agent.collapse')}
      >
        <span>▾</span>
        <span>{t('agent.toolConfig')}</span>
      </button>
      {/* 终端命令（shell_exec）策略：未设置工作目录时整体置灰 */}
      <div
        className={`mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs ${
          workspaceDir ? '' : 'opacity-40 pointer-events-none'
        }`}
        title={workspaceDir ? undefined : t('agent.shell.needWorkspace')}
      >
        <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
          <input
            type="checkbox"
            checked={shellConfig.enabled}
            onChange={(e) => void patchShellConfig({ enabled: e.target.checked })}
          />
          🖥 {t('agent.shell.enable')}
        </label>
        <label className="flex items-center gap-1 select-none">
          <span className="text-[var(--color-text-muted)]">{t('agent.shell.policy')}</span>
          <select
            className="select-mini"
            value={shellConfig.policy}
            disabled={!shellConfig.enabled}
            onChange={(e) =>
              void patchShellConfig({ policy: e.target.value as ShellConfig['policy'] })
            }
          >
            <option value="confirm">{t('agent.shell.policyConfirm')}</option>
            <option value="auto-safe">{t('agent.shell.policyAutoSafe')}</option>
          </select>
        </label>
        <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate">
          {shellConfig.enabled ? t('agent.shell.hintOn') : t('agent.shell.hintOff')}
        </span>
      </div>

      {/* 联网搜索（web.search）配置：Key 明文仅存主进程，渲染端不回显 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
          <input
            type="checkbox"
            checked={wsConfig.enabled}
            onChange={(e) => void patchWsConfig({ enabled: e.target.checked })}
          />
          🌐 {t('agent.websearch.title')}
        </label>
        <label className="flex items-center gap-1 select-none">
          <span className="text-[var(--color-text-muted)]">{t('agent.websearch.provider')}</span>
          <select
            className="select-mini"
            value={wsConfig.provider}
            disabled={!wsConfig.enabled}
            onChange={(e) =>
              void patchWsConfig({ provider: e.target.value as WebSearchConfig['provider'] })
            }
          >
            <option value="tavily">Tavily</option>
            <option value="bocha">{t('agent.websearch.providerBocha')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1 select-none min-w-0">
          <span className="text-[var(--color-text-muted)]">API Key</span>
          <input
            type="password"
            className="input-mini w-40"
            value={wsKeyDraft}
            disabled={!wsConfig.enabled}
            placeholder={
              wsConfig.hasKey ? t('agent.websearch.keySaved') : t('agent.websearch.keyPlaceholder')
            }
            onChange={(e) => setWsKeyDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && wsKeyDraft.trim()) {
                void patchWsConfig({ apiKey: wsKeyDraft.trim() })
              }
            }}
            onBlur={() => {
              if (wsKeyDraft.trim()) void patchWsConfig({ apiKey: wsKeyDraft.trim() })
            }}
          />
          {wsConfig.hasKey && (
            <button
              className="btn-ghost text-[11px] shrink-0"
              title={t('agent.websearch.keyClearTip')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void patchWsConfig({ apiKey: '' })}
            >
              {t('agent.websearch.keyClear')}
            </button>
          )}
        </label>
        <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate">
          {wsConfig.enabled ? t('agent.websearch.hintOn') : t('agent.websearch.hintOff')}
        </span>
      </div>

      {/* 本地日历（calendar.read）配置：添加 .ics 文件后 Agent 可读取日程 */}
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs">
        <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
          <input
            type="checkbox"
            checked={calConfig.enabled}
            onChange={(e) => void patchCalConfig({ enabled: e.target.checked })}
          />
          📅 {t('agent.calendar.title')}
        </label>
        <button
          className="btn-ghost text-[11px] shrink-0"
          onClick={() => void addIcs()}
          title={t('agent.calendar.addTip')}
        >
          + {t('agent.calendar.add')}
        </button>
        {calConfig.paths.map((p) => (
          <span
            key={p}
            className="inline-flex items-center gap-1 rounded bg-[var(--color-hover-overlay)] px-1.5 py-0.5 max-w-[220px]"
            title={p}
          >
            <span className="truncate">{p.split(/[\\/]/).filter(Boolean).pop() || p}</span>
            <button
              className="text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
              title={t('agent.calendar.removeTip')}
              onClick={() => void patchCalConfig({ paths: calConfig.paths.filter((x) => x !== p) })}
            >
              ×
            </button>
          </span>
        ))}
        <span className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate">
          {calConfig.enabled
            ? calConfig.paths.length > 0
              ? t('agent.calendar.hintOn')
              : t('agent.calendar.hintNoFile')
            : t('agent.calendar.hintOff')}
        </span>
      </div>
    </>
  )
}
