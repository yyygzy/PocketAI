// Agent 工具三行：shell 命令策略 / 联网搜索 / 本地日历（凭据明文仅存主进程，渲染端只拿 hasKey 标记＝不回显）
//
// §399②b：这一整块从"消息流之上那行可折叠的条"搬进了输入框那颗「+」的**嵌套第二层**——
// ① 那行折叠条本身收起时，屏上看着就是"这台机器三个工具都没开"（§257 记的那张谎脸），展开又是三行高度；
// ② 它与附件／片段／执行设置本是同一件事（这一轮怎么跑），散在两处。
// **三条「读不到」没有跟着搬进来**（§222／§268：句子住进浮层＝菜单一关就不说话＝替这次失败闭嘴）——
// 它们由对话壳输入区在浮层**外面**那一句区渲染，与文本协议／工作目录那两句同一处。
import React from 'react'
import type { ShellConfig, WebSearchConfig } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import type { AgentToolConfigs } from './useAgentToolConfigs'

/**
 * 「+」菜单里那颗摘要点的图标：开着哪几项就点哪几个（与下面那三行同源，不是第二份状态）。
 * 全关着时回空串——屏上不重复念一遍「工具配置」（旧折叠条那形是 `summary || t('agent.toolConfig')`，
 * 三个都没开时会念成「工具配置 工具配置」，本枚顺手把它去掉，不留第二张脸）。
 */
export const agentToolSummary = (
  tools: Pick<AgentToolConfigs, 'shellConfig' | 'wsConfig' | 'calConfig'>
): string =>
  [
    tools.shellConfig.enabled ? '🖥' : null,
    tools.wsConfig.enabled ? '🌐' : null,
    tools.calConfig.enabled ? '📅' : null
  ]
    .filter(Boolean)
    .join(' ')

export const AgentToolBars: React.FC<{ tools: AgentToolConfigs; onOpenPolicy?: () => void }> = ({
  tools,
  onOpenPolicy
}) => {
  const { t } = useI18n()
  const {
    workspaceDir,
    shellConfig,
    wsConfig,
    wsKeyDraft,
    wsUrlDraft,
    setWsKeyDraft,
    setWsUrlDraft,
    patchShellConfig,
    patchWsConfig,
    patchCalConfig,
    calConfig,
    addIcs,
    secretDialog,
    toolUnread
  } = tools

  // §410：这两句行内说明各自提成一个量＝正文与悬停的 title 取同一份，不存在"两份手写漂开"。
  // 它们原先挂在 truncate 上，298px 宽的浮层里四语都被裁掉尾巴（被裁的半句是安全限定语），
  // 而 jsdom 不做布局⇒CI 全绿看不见裁切，所以这两行的类名里不再出现 truncate，改由 flex-wrap 换行。
  const wsHint = !wsConfig.enabled
    ? t('agent.websearch.hintOff')
    : (wsConfig.provider === 'searxng'
        ? wsConfig.searxngBaseUrl
          ? t('agent.websearch.hintSearxng')
          : t('agent.websearch.searxngHint')
        : t('agent.websearch.hintOn')) +
      (wsConfig.depth === 'deep' ? ' · ' + t('agent.websearch.depthHint') : '')
  const calHint = !calConfig.enabled
    ? t('agent.calendar.hintOff')
    : calConfig.paths.length > 0
      ? t('agent.calendar.hintOn')
      : t('agent.calendar.hintNoFile')

  return (
    <div className="flex flex-col gap-1.5 py-1">
      {/* 终端命令（shell_exec）策略：未设置工作目录时整体置灰 */}
      <div
        className={`flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs ${
          workspaceDir ? '' : 'opacity-40 pointer-events-none'
        }`}
        title={
          workspaceDir
            ? undefined
            : toolUnread.workspace
              ? t('agent.workspaceUnread')
              : t('agent.shell.needWorkspace')
        }
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
        <span
          className="text-[11px] text-[var(--color-text-muted)] min-w-0 flex-1 truncate"
          title={shellConfig.enabled ? t('agent.shell.hintOn') : t('agent.shell.hintOff')}
        >
          {shellConfig.enabled ? t('agent.shell.hintOn') : t('agent.shell.hintOff')}
        </span>
      </div>

      {/* 联网搜索（web.search）配置：Key 明文仅存主进程，渲染端不回显 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs">
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
            <option value="searxng">{t('agent.websearch.providerSearxng')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1 select-none" title={t('agent.websearch.depthHint')}>
          <span className="text-[var(--color-text-muted)]">{t('agent.websearch.depth')}</span>
          <select
            className="select-mini"
            value={wsConfig.depth}
            disabled={!wsConfig.enabled}
            onChange={(e) =>
              void patchWsConfig({ depth: e.target.value as WebSearchConfig['depth'] })
            }
          >
            <option value="auto">{t('agent.websearch.depthAuto')}</option>
            <option value="quick">{t('agent.websearch.depthQuick')}</option>
            <option value="deep">{t('agent.websearch.depthDeep')}</option>
          </select>
        </label>
        {wsConfig.provider === 'searxng' ? (
          <>
            <label className="flex items-center gap-1 select-none min-w-0">
              <span className="text-[var(--color-text-muted)]">{t('agent.websearch.searxngUrl')}</span>
              <input
                type="text"
                className="input-mini w-56"
                value={wsUrlDraft}
                disabled={!wsConfig.enabled}
                placeholder={t('agent.websearch.searxngUrlPlaceholder')}
                onChange={(e) => setWsUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    const next = wsUrlDraft.trim()
                    if (next !== wsConfig.searxngBaseUrl) void patchWsConfig({ searxngBaseUrl: next })
                  }
                }}
                onBlur={() => {
                  const next = wsUrlDraft.trim()
                  if (next !== wsConfig.searxngBaseUrl) void patchWsConfig({ searxngBaseUrl: next })
                }}
              />
            </label>
            <label
              className="flex items-center gap-1 select-none"
              title={t('agent.websearch.searxngAllowPrivateWarn')}
            >
              <input
                type="checkbox"
                checked={wsConfig.searxngAllowPrivate}
                disabled={!wsConfig.enabled || !wsConfig.searxngBaseUrl}
                onChange={(e) =>
                  void patchWsConfig({ searxngAllowPrivate: e.target.checked })
                }
              />
              <span className="text-[var(--color-text-muted)]">
                {t('agent.websearch.searxngAllowPrivate')}
              </span>
            </label>
            {wsConfig.searxngAllowPrivate && (
              <span className="text-[11px] text-[var(--color-danger)]">
                {t('agent.websearch.searxngAllowPrivateWarn')}
              </span>
            )}
          </>
        ) : (
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
                // §340：§336 修过 ChannelsPanel 那颗凭据框，这张屏是同一形状的漏掉的姊妹处——
                // Enter 之后 confirmSecret 弹窗会抢走 focus⇒onBlur 紧跟着追发第二发，
                // 同一份 Key 写两次、两张确认弹窗叠上来。键盘这条同步清草稿再发；
                // onBlur 不清，用户取消确认时草稿还在、可重试（与 ChannelsPanel 同口径）
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && wsKeyDraft.trim()) {
                  const trimmed = wsKeyDraft.trim()
                  setWsKeyDraft('')
                  void patchWsConfig({ apiKey: trimmed })
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
        )}
        <span className="w-full basis-full text-[11px] text-[var(--color-text-muted)]" title={wsHint}>
          {wsHint}
        </span>
        {/* 密钥确认弹窗就渲染在这一行里（§399②b 后它在嵌套层**内部**）＝点「确认」不算"点浮层外面"，
            外层那颗「+」与这一层都不会被那一下 mousedown 关掉 */}
        {secretDialog}
      </div>

      {/* 本地日历（calendar.read）配置：添加 .ics 文件后 Agent 可读取日程 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-1.5 text-xs">
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
        <span className="w-full basis-full text-[11px] text-[var(--color-text-muted)]" title={calHint}>
          {calHint}
        </span>
      </div>

      {/* P0-3a：只读策略总览入口。放在工具配置里，是因为用户正是在这里问"它到底能碰什么"；
          不另开设置层级（屏本身也只读，不承担编辑职责）。 */}
      {onOpenPolicy && (
        <button
          type="button"
          onClick={onOpenPolicy}
          className="mt-0.5 self-start text-[11px] px-2 py-1 rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]"
          title={t('tp.openTip')}
        >
          {t('tp.open')}
        </button>
      )}
    </div>
  )
}
