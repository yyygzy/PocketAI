// 模型级配置（P4 批次 0 迁移）：上下文窗口覆盖 / 备用模型链 / 文本协议点名。
//
// 这三项原来只长在 Agent 壳（P4 批次 2 已删）。迁移口径要求「不留第二份实现」，
// 因此状态、挂载读、写回与三态话术全部收在这里：
// · 对话壳的 `ChatModelExtras` 调用本 hook；
// · 展示层只保留一份 `ModelExtrasBadges`。
//
// 三条贯穿约束（照搬原实现，不重新发明）：
//  ① 读不到 ≠ 没设过：窗口表/备用表/文本协议清单读失败时保留 unread 原因，界面给"读不到"那张脸；
//  ② 不做本地乐观更新：写通道回传的最新表才是事实（服务层拒绝时只 toast，不动屏上值）；
//  ③ 拒绝码逐条翻译：数字取自共享常量，四语 key 既有，不新增文案。
import { useCallback, useEffect, useState } from 'react'
import type { ProviderRecord } from '../../../../shared/types'
import type { FallbackTarget } from '../../../../shared/fallback-target'
import { fallbackTargetKey } from '../../../../shared/fallback-target'
import { modelWindowKey } from '../../../../shared/model-window'
import { MODEL_WINDOW_MAX_TOKENS, MODEL_WINDOW_MIN_TOKENS } from '../../../../shared/model-window'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { hasIpcFailed, ipcFailText, logIpcError, reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'

export interface AgentModelExtras {
  /** 当前 provider+model 已被点名走文本协议 */
  textProtocolForced: boolean
  textProtocolUnread: string | null
  /** 文本协议清单重读（「读不到」那句旁边的同级出口） */
  retryTextProtocol: () => void
  setTextProtocol: (on: boolean) => void
  /** 当前模型声明的窗口；null=未设（引擎退回「最近 30 条」） */
  contextWindowTokens: number | null
  contextWindowUnread: string | null
  setContextWindow: (tokens: number | null) => void
  /** 当前模型的备用 target；null=没设过 */
  fallbackTarget: FallbackTarget | null
  /** 设了但目标已不在本实例（provider 删除/停用/模型清单漂移） */
  fallbackMissing: boolean
  fallbackUnread: string | null
  setFallback: (target: FallbackTarget | null) => void
}

export function useAgentModelExtras(
  providerId: string,
  model: string,
  providers: ProviderRecord[]
): AgentModelExtras {
  const { t } = useI18n()
  const toast = useToast()
  /** 被点名「走文本协议」的模型键（`providerId::model`）；开关存 app_config，跨重启保留 */
  const [textProtocolModels, setTextProtocolModels] = useState<string[]>([])
  // §257：这发读失败时徽标会显示「文本协议」（＝没走），与"读到了但没走"同一张脸
  const [textProtocolUnread, setTextProtocolUnread] = useState<string | null>(null)
  /** §234：每台模型声明的上下文窗口（键同上，值是 token 数）。表里没有=未设=按 30 条 */
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({})
  /** 那一读失败过：界面不许把"没读到"演成"没有一台模型设过窗口"（§222 那一族） */
  const [modelWindowsUnread, setModelWindowsUnread] = useState<string | null>(null)
  /** §237：每台模型的备用 target 表（`providerId::model` → 一台）；表里没那台＝没设过 */
  const [fallbackTargets, setFallbackTargets] = useState<Record<string, FallbackTarget>>({})
  const [fallbackUnread, setFallbackUnread] = useState<string | null>(null)

  /**
   * 文本协议清单：抽成具名 loader——开关旁边那句「读不到」需要一键重读的出口
   * （这一读只在挂载跑一次，没有"再点那一格就自己重拉"的天然出口）。
   */
  const loadTextProtocol = useCallback(() => {
    void window.pocketai
      .getAgentTextProtocol()
      .then((list) => {
        if (hasIpcFailed(list)) {
          setTextProtocolUnread(ipcFailText(list, t('agent.unknownError')))
          return
        }
        setTextProtocolUnread(null)
        setTextProtocolModels(Array.isArray(list) ? list : [])
      })
      .catch((e: unknown) => {
        setTextProtocolUnread(errText(e, t('agent.unknownError')))
        logIpcError('agent.getTextProtocol', e)
      })
  }, [t])

  useEffect(() => {
    loadTextProtocol()
  }, [loadTextProtocol])

  /** 当前选中的 provider+model 是否已被点名走文本协议 */
  const textProtocolForced = !!providerId && !!model && textProtocolModels.includes(`${providerId}::${model}`)

  // §234：每台模型的上下文窗口表，挂载读一次，之后以 set 通道回传的最新值为准
  useEffect(() => {
    void window.pocketai
      .getModelContextWindows()
      .then((res) => {
        if (hasIpcFailed(res)) {
          // 读不到不许咽成空表——空表在界面上和"没有一台模型设过窗口"长得一模一样
          setModelWindowsUnread(ipcFailText(res, t('agent.unknownError')))
          return
        }
        setModelWindowsUnread(null)
        setModelWindows(res)
      })
      .catch(reportIpcError('agent.getModelContextWindows'))
  }, [t])

  /** 当前选中模型声明的窗口；null=未设（引擎那一侧退回"最近 30 条"的旧口径） */
  const contextWindowTokens = providerId && model ? modelWindows[modelWindowKey(providerId, model)] ?? null : null

  /**
   * 设/清当前这台模型的窗口（下一轮运行生效）。
   * 三条失败面各说各的：IPC 失败⇒原因；服务层回码拒绝⇒那句"这个数不行"；
   * 两者都不做本地乐观更新——表以库里回传的为准。
   */
  const setContextWindow = useCallback(
    (tokens: number | null) => {
      if (!providerId || !model) return
      void window.pocketai
        .setModelContextWindow(providerId, model, tokens)
        .then((res) => {
          if (hasIpcFailed(res)) {
            toast.error(ipcFailText(res, t('agent.unknownError')))
            return
          }
          if (res.rejected) {
            toast.error(
              res.rejected === 'MODEL_WINDOW_INVALID_VALUE'
                ? t('agent.window.rejected.MODEL_WINDOW_INVALID_VALUE', {
                    min: MODEL_WINDOW_MIN_TOKENS,
                    max: MODEL_WINDOW_MAX_TOKENS
                  })
                : t('agent.window.rejected.MODEL_WINDOW_INVALID_ID')
            )
            return
          }
          setModelWindows(res.windows)
          setModelWindowsUnread(null)
        })
        .catch(reportIpcError('agent.setModelContextWindow'))
    },
    [providerId, model, toast, t]
  )

  // §237：备用 target 表，挂载读一次，之后以 set 通道回传的最新表为准（不做本地乐观更新）
  useEffect(() => {
    void window.pocketai
      .getFallbackTargets()
      .then((res) => {
        if (hasIpcFailed(res)) {
          // 读不到不许咽成空表——空表在界面上和"没有一台模型设过备用"长得一模一样
          setFallbackUnread(ipcFailText(res, t('agent.unknownError')))
          return
        }
        setFallbackUnread(null)
        setFallbackTargets(res)
      })
      .catch(reportIpcError('agent.getFallbackTargets'))
  }, [t])

  /** 当前选中那台模型的备用；null=没设过 */
  const fallbackTarget = providerId && model ? fallbackTargets[fallbackTargetKey(providerId, model)] ?? null : null

  /**
   * 备用**设过但那台已经不在这个实例里**：provider 不在清单／被停用，或模型清单里没这个名字。
   * 判据与引擎那处逐字同一条（enabled ＋ models.includes），差别只是界面拿得到列表，能把它说出来。
   */
  const fallbackMissing = (() => {
    if (!fallbackTarget) return false
    const p = providers.find((x) => x.id === fallbackTarget.providerId)
    return !p || !p.enabled || !p.models.includes(fallbackTarget.model)
  })()

  /**
   * 设/清当前这台模型的备用（下一轮运行生效）。
   * 三档失败各说各的；都不做本地乐观更新。
   */
  const setFallback = useCallback(
    (target: FallbackTarget | null) => {
      if (!providerId || !model) return
      void window.pocketai
        .setFallbackTarget(providerId, model, target)
        .then((res) => {
          if (hasIpcFailed(res)) {
            toast.error(ipcFailText(res, t('agent.unknownError')))
            return
          }
          if (res.rejected) {
            toast.error(
              t(
                res.rejected === 'FALLBACK_IS_SELF'
                  ? 'agent.fallback.rejected.FALLBACK_IS_SELF'
                  : 'agent.fallback.rejected.FALLBACK_INVALID_ID'
              )
            )
            return
          }
          setFallbackTargets(res.targets)
          setFallbackUnread(null)
        })
        .catch(reportIpcError('agent.setFallbackTarget'))
    },
    [providerId, model, toast, t]
  )

  /** 开/关当前这台模型的文本协议（下一轮运行生效；不做本地乐观更新，以库里回传的清单为准） */
  const setTextProtocol = useCallback(
    (on: boolean) => {
      if (!providerId || !model) return
      void window.pocketai
        .setAgentTextProtocol(providerId, model, on)
        .then((list) => {
          // §221：这是用户点的那一下，失败必须说话。`Array.isArray(list) ? list : []`
          // 会把 `{ok:false}` 咽成空清单 ⇒ 按钮自己变回「文本协议」，看起来像"关掉了"
          if (hasIpcFailed(list)) {
            toast.error(ipcFailText(list, t('agent.unknownError')))
            return
          }
          setTextProtocolModels(Array.isArray(list) ? list : [])
          setTextProtocolUnread(null)
        })
        .catch(reportIpcError('agent.setAgentTextProtocol'))
    },
    [providerId, model, toast, t]
  )

  return {
    textProtocolForced,
    textProtocolUnread,
    retryTextProtocol: loadTextProtocol,
    setTextProtocol,
    contextWindowTokens,
    contextWindowUnread: modelWindowsUnread,
    setContextWindow,
    fallbackTarget,
    fallbackMissing,
    fallbackUnread,
    setFallback
  }
}
