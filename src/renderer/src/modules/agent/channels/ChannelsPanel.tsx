// Channels（IM Bot 网关：多网关）
// 5 个网关：Telegram / 飞书 / 钉钉 / Slack / Discord，全部主动拉取消息
// 凭据明文仅存主进程，渲染端只拿 hasPrimary/hasSecondary 标记（不回显）
import React, { useCallback, useEffect, useState } from 'react'
import type {
  ProviderRecord,
  AssistantRecord,
  ChannelConfig,
  ChannelStatusEvent,
  ChannelType
} from '../../../../../shared/types'
import { CHANNEL_TYPES } from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { assistantDisplayName } from '../../chat/assistant-display'
import { useToast } from '../../../components/ToastProvider'
import { hasIpcFailed, ipcFailText, logIpcError } from '../../../utils/ipc'
import { LoadFailNotice } from '../../../components/LoadFailNotice'
import { ShowingDefaultsNotice } from '../../../components/ShowingDefaultsNotice'
import { errText } from '../../../utils/error'
import { StatusDot, MiniBtn } from '../ui'
import { useConfirm } from '../../../components/ConfirmDialog'
import { isUnprotectedMode } from '../../../utils/secret-consent'

export const ChannelsPanel: React.FC = () => {
  const { t } = useI18n()
  const toast = useToast()
  const { confirm, dialog: confirmDialog } = useConfirm()
  const [activeType, setActiveType] = useState<ChannelType>('telegram')
  // 各网关配置缓存（按 type 分开）
  const [cfgs, setCfgs] = useState<Partial<Record<ChannelType, ChannelConfig>>>({})
  // §333：某一类配置读不到时，那一格不许装作「默认值就是实情」⇒ 按 type 点名
  const [cfgsUnread, setCfgsUnread] = useState<Partial<Record<ChannelType, { error?: string }>>>({})
  const [statuses, setStatuses] = useState<Partial<Record<ChannelType, ChannelStatusEvent>>>({})
  // 主凭据草稿（Telegram/Discord 单 token；Slack 用两个草稿；飞书/钉钉 secondary 也分）
  const [primaryDraft, setPrimaryDraft] = useState('')
  const [secondaryDraft, setSecondaryDraft] = useState('')
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  /**
   * §271：这两发都在挂载读，失败侧过去只有 `if (!hasIpcFailed(v)) 写 state`＝什么都不做
   * ⇒ 两枚下拉里只剩占位项（「未绑定助手」「请选择服务商」），把通道故障演成"你一个助手／服务商都没建"。
   * 这一屏没有任何天然重发点（切网关类型不会重拉这两份清单）⇒ 各配一颗重试键（§268 口径）。
   */
  const [providersUnread, setProvidersUnread] = useState<{ error?: string } | null>(null)
  const [assistantsUnread, setAssistantsUnread] = useState<{ error?: string } | null>(null)

  const loadProviders = useCallback(() => {
    window.pocketai.listProviders()
      .then((ps) => {
        if (hasIpcFailed(ps)) {
          setProvidersUnread({ error: ps.error })
          return
        }
        setProvidersUnread(null)
        setProviders(ps.filter((p) => p.enabled))
      })
      .catch((e: unknown) => {
        setProvidersUnread({ error: errText(e, '') })
        logIpcError('channels.listProviders', e)
      })
  }, [])

  const loadAssistants = useCallback(() => {
    window.pocketai.listAssistants()
      .then((v) => {
        if (hasIpcFailed(v)) {
          setAssistantsUnread({ error: v.error })
          return
        }
        setAssistantsUnread(null)
        setAssistants(v)
      })
      .catch((e: unknown) => {
        setAssistantsUnread({ error: errText(e, '') })
        logIpcError('channels.listAssistants', e)
      })
  }, [])

  useEffect(() => {
    void loadAllConfigs()
    loadProviders()
    loadAssistants()
    return window.pocketai.onChannelStatus((evt) =>
      setStatuses((prev) => ({ ...prev, [evt.type]: evt }))
    )
    // 三发都是挂载那一次的读；两根 loader 是 useCallback([]) ⇒ 依赖恒稳
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadAllConfigs = async (): Promise<void> => {
    const next: Partial<Record<ChannelType, ChannelConfig>> = {}
    const failed: Partial<Record<ChannelType, { error?: string }>> = {}
    for (const type of CHANNEL_TYPES) {
      try {
        const c = await window.pocketai.getChannelConfig(type)
        // §223：不判就把 `{ok:false}` 塞进 cfgs ⇒ 消费方那句 `cfgs[activeType] ?? 默认值` 拦不住（它是真值），
        // 于是开关面板读的是失败对象的字段。跳过这一条，让它退回默认值，并把原因留痕
        if (hasIpcFailed(c)) {
          failed[type] = { error: c.error }
          logIpcError(`channels.getConfig:${type}`, new Error(ipcFailText(c, t('common.unknownError'))))
          continue
        }
        next[type] = c
      } catch (e) {
        failed[type] = { error: errText(e) }
        logIpcError(`channels.getConfig:${type}`, e)
      }
    }
    setCfgs(next)
    setCfgsUnread(failed)
    // 同步状态快照
    try {
      const snap = await window.pocketai.listChannelStatus()
      // §219：失败对象不是快照 ⇒ Object.entries 会端出 ['ok',false]／['error',…] 当渠道类型用，而真正的网关状态被显示成「已停止」
      if (hasIpcFailed(snap)) {
        logIpcError('channels.listStatus', new Error(ipcFailText(snap, t('common.unknownError'))))
        return
      }
      const ss: Partial<Record<ChannelType, ChannelStatusEvent>> = {}
      for (const [type, s] of Object.entries(snap)) {
        ss[type as ChannelType] = { type: type as ChannelType, status: s.status as ChannelStatusEvent['status'], lastError: s.lastError }
      }
      setStatuses((prev) => ({ ...prev, ...ss }))
    } catch (e) {
      logIpcError('channels.listStatus', e)
    }
  }

  const cfg = cfgs[activeType] ?? {
    type: activeType,
    enabled: false,
    hasPrimarySecret: false,
    hasSecondarySecret: false,
    appId: '',
    whitelist: '',
    assistantId: '',
    providerId: '',
    model: '',
    agentMode: false
  }

  const status = statuses[activeType] ?? { type: activeType, status: 'stopped' as const, lastError: null }

  const patchCfg = async (
    patch: Partial<
      Pick<
        ChannelConfig,
        | 'enabled'
        | 'whitelist'
        | 'appId'
        | 'assistantId'
        | 'providerId'
        | 'model'
        | 'agentMode'
      >
    > & { primarySecret?: string; secondarySecret?: string }
  ) => {
    // 凭据超长预检（后端仍有同样校验）；失败保留草稿便于修改
    if (typeof patch.primarySecret === 'string' && patch.primarySecret.trim().length > 512) {
      toast.error(t('channel.secretTooLong'))
      return
    }
    if (typeof patch.secondarySecret === 'string' && patch.secondarySecret.trim().length > 512) {
      toast.error(t('channel.secretTooLong'))
      return
    }
    // B3：新填的凭据在明文模式下只是固定密钥混淆 ⇒ 先让用户承认再保存
    const submittingSecret =
      (typeof patch.primarySecret === 'string' && patch.primarySecret.trim() !== '') ||
      (typeof patch.secondarySecret === 'string' && patch.secondarySecret.trim() !== '')
    if (submittingSecret && (await isUnprotectedMode())) {
      const ok = await confirm({ message: t('secret.unprotectedWarn'), danger: true })
      if (!ok) return
    }
    try {
      // §333：乐观更新失败时回滚——快照在飞之前的值，IPC 失败时还原
      const snapshot = cfgs[activeType]
      const next = await window.pocketai.setChannelConfig(activeType, patch)
      // §219：失败不判就把 `{ok:false}` 写成本渠道的配置 ⇒ 表单显示的是库里没有的配置
      if (hasIpcFailed(next)) {
        // 回滚到快照
        if (snapshot) setCfgs((prev) => ({ ...prev, [activeType]: snapshot }))
        toast.error(ipcFailText(next, t('common.unknownError')))
        return
      }
      setCfgs((prev) => ({ ...prev, [activeType]: next }))
      if (patch.primarySecret !== undefined) setPrimaryDraft('')
      if (patch.secondarySecret !== undefined) setSecondaryDraft('')
    } catch (e) {
      toast.error(errText(e, t('common.unknownError')))
    }
  }

  const handleStart = async () => {
    const r = await window.pocketai.startChannel(activeType)
    if (!r.ok) toast.error(r.error ?? t('common.unknownError'))
  }
  const handleStop = async () => {
    const r = await window.pocketai.stopChannel(activeType)
    // §217：safeHandle 的失败是 resolve 的 `{ok:false}`，这一条既没判也没 catch ⇒ 停没停下来界面看不出来
    if (hasIpcFailed(r)) toast.error(ipcFailText(r, t('common.unknownError')))
  }

  // 切换 tab 时清空凭据草稿
  const switchType = (type: ChannelType): void => {
    setActiveType(type)
    setPrimaryDraft('')
    setSecondaryDraft('')
  }

  const gatewayActive = status.status === 'running' || status.status === 'starting'
  const selectedProvider = providers.find((p) => p.id === cfg.providerId)

  // 该网关是否需要主/次凭据
  const needPrimary = activeType === 'telegram' || activeType === 'discord' || activeType === 'slack'
  const needSecondary = activeType === 'slack' || activeType === 'feishu' || activeType === 'dingtalk'
  const needAppId = activeType === 'feishu' || activeType === 'dingtalk'

  return (
    <div className="h-full overflow-y-auto pr-1 max-w-2xl space-y-3">
      {/* 说明 */}
      <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
        {t('channel.desc')}
      </p>

      {/* 网关类型 tab */}
      <div className="flex flex-wrap gap-2 text-sm">
        {CHANNEL_TYPES.map((type) => (
          <button
            key={type}
            className={`px-3 py-1.5 rounded-md border font-medium transition-colors ${
              activeType === type
                ? 'bg-[var(--color-accent)] text-[var(--color-on-accent)] border-[var(--color-accent)]'
                : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)]'
            }`}
            onClick={() => switchType(type)}
          >
            {t(`channel.${type}.title`)}
          </button>
        ))}
      </div>

      {/* 该网关说明 */}
      <p className="text-xs text-[var(--color-text-muted)] leading-relaxed">
        {t(`channel.${activeType}.desc`)}
      </p>

      {/* §333：这一类配置读不到时，下面那堆字段全是默认值——点名让用户知道 */}
      {cfgsUnread[activeType] && (
        <ShowingDefaultsNotice
          what={t(`channel.${activeType}.title`)}
          msg={ipcFailText(cfgsUnread[activeType]!, t('common.unknownError'))}
        />
      )}

      {/* 运行状态 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs">
        <StatusDot status={status.status} />
        <span className="font-medium">{t(`channel.status.${status.status}`)}</span>
        {status.lastError && (
          <span className="text-[var(--color-danger)] truncate max-w-[320px]" title={status.lastError}>
            {status.lastError}
          </span>
        )}
        <span className="flex-1" />
        {gatewayActive ? (
          <MiniBtn onClick={() => void handleStop()}>{t('channel.stop')}</MiniBtn>
        ) : (
          <button
            className="btn-ghost text-xs"
            disabled={status.status === 'starting'}
            onClick={() => void handleStart()}
          >
            {t('channel.start')}
          </button>
        )}
      </div>

      {/* 启用开关 */}
      <label className="flex items-center gap-1.5 cursor-pointer select-none text-sm font-medium">
        <input
          type="checkbox"
          checked={cfg.enabled}
          onChange={(e) => void patchCfg({ enabled: e.target.checked })}
        />
        {t('channel.enable')}
      </label>

      {/* 凭据字段（按网关类型变化） */}
      {needPrimary && (
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">
            {activeType === 'slack' ? t('channel.slack.botToken') : t(`channel.${activeType}.token`)}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              className="input-mini flex-1"
              value={primaryDraft}
              placeholder={
                cfg.hasPrimarySecret
                  ? t('channel.tokenSaved')
                  : activeType === 'slack'
                    ? t('channel.slack.botTokenPlaceholder')
                    : t(`channel.${activeType}.tokenPlaceholder`)
              }
              onChange={(e) => setPrimaryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && primaryDraft.trim()) void patchCfg({ primarySecret: primaryDraft.trim() })
              }}
              onBlur={() => {
                if (primaryDraft.trim()) void patchCfg({ primarySecret: primaryDraft.trim() })
              }}
            />
            {cfg.hasPrimarySecret && (
              <button
                className="btn-ghost text-[11px] shrink-0"
                title={t('channel.tokenClearTip')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void patchCfg({ primarySecret: '' })}
              >
                {t('channel.tokenClear')}
              </button>
            )}
          </div>
        </div>
      )}

      {needSecondary && (
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">
            {activeType === 'slack'
              ? t('channel.slack.appToken')
              : t(`channel.${activeType}.appSecret`)}
          </div>
          <div className="flex items-center gap-1.5">
            <input
              type="password"
              className="input-mini flex-1"
              value={secondaryDraft}
              placeholder={
                cfg.hasSecondarySecret
                  ? t('channel.tokenSaved')
                  : activeType === 'slack'
                    ? t('channel.slack.appTokenPlaceholder')
                    : t(`channel.${activeType}.appSecretPlaceholder`)
              }
              onChange={(e) => setSecondaryDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && secondaryDraft.trim()) void patchCfg({ secondarySecret: secondaryDraft.trim() })
              }}
              onBlur={() => {
                if (secondaryDraft.trim()) void patchCfg({ secondarySecret: secondaryDraft.trim() })
              }}
            />
            {cfg.hasSecondarySecret && (
              <button
                className="btn-ghost text-[11px] shrink-0"
                title={t('channel.tokenClearTip')}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void patchCfg({ secondarySecret: '' })}
              >
                {t('channel.tokenClear')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* App ID（飞书 / 钉钉，非密钥） */}
      {needAppId && (
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">
            {t(`channel.${activeType}.appId`)}
          </div>
          <input
            className="input-mini w-full"
            value={cfg.appId}
            placeholder={t(`channel.${activeType}.appIdPlaceholder`)}
            onChange={(e) => setCfgs((prev) => ({
              ...prev,
              [activeType]: { ...(prev[activeType] ?? cfg), appId: e.target.value }
            }))}
            onBlur={(e) => void patchCfg({ appId: e.target.value })}
          />
        </div>
      )}

      {/* 白名单（fail closed：空=拒绝所有） */}
      <div>
        <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.whitelist')}</div>
        <input
          className="input-mini w-full"
          value={cfg.whitelist}
          placeholder={t('channel.whitelistPlaceholder')}
          onChange={(e) => setCfgs((prev) => ({
            ...prev,
            [activeType]: { ...(prev[activeType] ?? cfg), whitelist: e.target.value }
          }))}
          onBlur={(e) => void patchCfg({ whitelist: e.target.value })}
        />
        <div className="text-[11px] text-[var(--color-text-muted)] mt-1">
          {t(`channel.${activeType}.whitelistHint`)}
        </div>
      </div>

      {/* 绑定助手 + 目标模型 */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.assistant')}</div>
          <select
            className="select-mini w-full"
            value={cfg.assistantId}
            onChange={(e) => void patchCfg({ assistantId: e.target.value })}
          >
            <option value="">{t('channel.assistantNone')}</option>
            {assistants.map((a) => (
              <option key={a.id} value={a.id}>{assistantDisplayName(a, t)}</option>
            ))}
          </select>
          {/* §271：读不到就说读不到——「未绑定助手」那一项不是"你没有助手"的证据。键在 alert 盒子外面（§268） */}
          {assistantsUnread && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <LoadFailNotice what={t('common.assistantsList')} msg={ipcFailText(assistantsUnread, t('common.unknownError'))} />
              <button
                data-testid="channels-assistants-retry"
                className="text-xs underline text-[var(--color-text-muted)]"
                onClick={loadAssistants}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
        </div>
        <div>
          <div className="text-xs text-[var(--color-text-muted)] mb-1">{t('channel.model')}</div>
          <select
            className="select-mini w-full"
            value={cfg.providerId}
            onChange={(e) => void patchCfg({ providerId: e.target.value, model: '' })}
          >
            <option value="">{t('agent.selectProvider')}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          {/* §271：这一发失败还会连带让下面那枚「模型」下拉整块不出现（`selectedProvider` 只能是 null）⇒ 那句要自己说清楚是哪一格读不到 */}
          {providersUnread && (
            <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
              <LoadFailNotice what={t('common.providersList')} msg={ipcFailText(providersUnread, t('common.unknownError'))} />
              <button
                data-testid="channels-providers-retry"
                className="text-xs underline text-[var(--color-text-muted)]"
                onClick={loadProviders}
              >
                {t('agent.retryRead')}
              </button>
            </div>
          )}
        </div>
      </div>
      {selectedProvider && (
        <select
          className="select-mini w-full"
          value={cfg.model}
          onChange={(e) => void patchCfg({ model: e.target.value })}
        >
          <option value="">{selectedProvider.models.length > 0 ? t('agent.selectModel') : t('agent.noModelsHint')}</option>
          {selectedProvider.models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
      <div className="text-[11px] text-[var(--color-text-muted)]">{t('channel.modelHint')}</div>

      {/* Agent 模式开关（远程工具调用，风险提示） */}
      <div className="rounded-md border border-[var(--color-border)] px-2.5 py-2 text-xs space-y-1">
        <label className="flex items-center gap-1.5 cursor-pointer select-none font-medium">
          <input
            type="checkbox"
            checked={cfg.agentMode}
            onChange={(e) => void patchCfg({ agentMode: e.target.checked })}
          />
          🤖 {t('channel.agentMode')}
        </label>
        <div className="text-[11px] text-[var(--color-text-muted)]">
          {t('channel.agentModeHint')}
        </div>
        {cfg.agentMode && (
          <div className="text-[11px] text-[var(--color-warning)]">{t('channel.agentModeRisk')}</div>
        )}
      </div>
      {confirmDialog}
    </div>
  )
}
