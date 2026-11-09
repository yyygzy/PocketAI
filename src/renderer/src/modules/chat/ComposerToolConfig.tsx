// 工具配置（终端 / 联网 / 日历 / 工作目录）在对话壳的落点（P4 批次 0 / 选项 A）
//
// 迁移口径：
// · 状态与写回**只有一份**——`useAgentToolConfigs`（原 Agent 壳那份，未复制）；
// · 控件也**只有一份**——`AgentToolBars`（原来挂在 Agent 壳「+」的第二层，这里原样复用）；
// · 本文件只是「对话壳的挂载点」：一颗触发键 + 一层浮层 + 浮层外面的「读不到」句子。
// · 布局约束随组件一起保留：`AgentToolBars` 的说明行不 truncate、改 flex-wrap（298px 窄浮层会把
//   安全限定语的尾巴裁掉，而 jsdom 不做布局看不见——这是那一次真机量的教训）。
// · 「读不到」句子**不能进浮层**：菜单一关句子就没了＝替这次失败闭嘴（§222／§268）。三发工具读
//   的出口是「当场改一次配置」，故只有句子不造重试键；工作目录那一读带同级重试键（同 Agent 壳口径）。
// · 本组件只在 `agentMode=true` 时由 Composer 挂载：普通对话不出工具配置，也就不发这四发读数。
import React, { useRef, useState } from 'react'
import { useI18n } from '../../i18n'
import { FloatingPanel } from '../../components/FloatingPanel'
import { ShowingDefaultsNotice } from '../../components/ShowingDefaultsNotice'
import { AgentToolBars, agentToolSummary } from './AgentToolBars'
import { useAgentToolConfigs } from './useAgentToolConfigs'

export const ComposerToolConfig: React.FC = () => {
  const { t } = useI18n()
  const tools = useAgentToolConfigs()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const anyUnread =
    !!tools.toolUnread.workspace ||
    !!tools.toolUnread.shell ||
    !!tools.toolUnread.webSearch ||
    !!tools.toolUnread.calendar

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <button
          ref={triggerRef}
          type="button"
          data-testid="chat-tool-config-open"
          aria-haspopup="menu"
          aria-expanded={open}
          title={open ? t('agent.collapse') : t('agent.expand')}
          onClick={() => setOpen((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg border px-2 py-0.5 text-[11px] transition-colors ${
            anyUnread
              ? 'border-[var(--color-danger)] text-[var(--color-danger)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
          }`}
        >
          <span aria-hidden>🛠</span>
          <span>{t('agent.toolConfig')}</span>
          <span className="opacity-70">{agentToolSummary(tools)}</span>
        </button>
        {/* 工作目录：读不到时给同级重试键（这一读没有「再点那一格就自己重拉」的天然出口） */}
        {tools.toolUnread.workspace && (
          <>
            <span role="alert" className="text-[11px] text-[var(--color-danger)]" title={tools.toolUnread.workspace}>
              {t('agent.workspaceUnread')}
            </span>
            <button
              type="button"
              data-testid="chat-tool-config-workspace-retry"
              className="text-[11px] underline text-[var(--color-text-muted)]"
              onClick={() => tools.retryWorkspace()}
            >
              {t('agent.retryRead')}
            </button>
          </>
        )}
      </div>

      {open && (
        <FloatingPanel
          anchorRef={triggerRef}
          width={300}
          onClose={() => setOpen(false)}
          data-testid="chat-tool-config-menu"
        >
          {/* 工作目录那一行与 Agent 壳同口径：选完目录终端才可用（AgentToolBars 里据此置灰） */}
          <button
            type="button"
            role="menuitem"
            data-testid="chat-tool-config-workspace"
            title={
              tools.toolUnread.workspace
                ? `${t('agent.workspaceUnread')} — ${tools.toolUnread.workspace}`
                : tools.workspaceDir || t('agent.workspacePickTip')
            }
            onClick={() => {
              setOpen(false)
              void tools.pickWorkspace()
            }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors ${
              tools.toolUnread.workspace
                ? 'text-[var(--color-danger)]'
                : 'text-[var(--color-text)] hover:bg-[var(--color-hover-overlay)]'
            }`}
          >
            <span aria-hidden>📁</span>
            <span className="flex-1 min-w-0">
              {tools.toolUnread.workspace
                ? t('agent.workspaceReadFail')
                : tools.workspaceDir
                  ? tools.workspaceDir.split(/[\\/]/).filter(Boolean).pop() || tools.workspaceDir
                  : t('agent.workspaceNone')}
            </span>
          </button>
          <div className="my-1 border-t border-[var(--color-border)]" />
          <div className="max-h-[52vh] overflow-y-auto">
            <AgentToolBars tools={tools} />
          </div>
        </FloatingPanel>
      )}

      {/* 浮层外面：工具那三发的「读不到」（出口＝当场改一次配置，写成功即清位，故无重试键） */}
      {tools.toolUnread.shell && (
        <ShowingDefaultsNotice what={t('agent.shell.enable')} msg={tools.toolUnread.shell} />
      )}
      {tools.toolUnread.webSearch && (
        <ShowingDefaultsNotice what={t('agent.websearch.title')} msg={tools.toolUnread.webSearch} />
      )}
      {tools.toolUnread.calendar && (
        <ShowingDefaultsNotice what={t('agent.calendar.title')} msg={tools.toolUnread.calendar} />
      )}

      {/* 明文模式保存新 Key 的确认弹窗：渲染在组件根（不随浮层关闭而丢） */}
      {tools.secretDialog}
    </div>
  )
}
