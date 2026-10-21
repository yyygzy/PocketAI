// Agent 对话核心：助手/会话/消息流（reducer）/运行状态/Provider·模型选择/发送与中止
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AgentChunkEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  AgentRunStats,
  AgentSessionStats,
  AgentStepEvent,
  AgentTraceRecord,
  AssistantRecord,
  ChatAttachment,
  ConversationRecord,
  MessageRecord,
  ProviderRecord
} from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import {
  MODEL_WINDOW_MAX_TOKENS,
  MODEL_WINDOW_MIN_TOKENS,
  modelWindowKey
} from '../../../../../shared/model-window'
import { chatSendFailureText, hasIpcFailed, ipcFailText, ipcFailureText, logIpcError, reportIpcError, type IpcFailureInput } from '../../../utils/ipc'
import { errText } from '../../../utils/error'
import { useToast } from '../../../components/ToastProvider'
import { findRerunSourceId, toAgentMessages, reduceLiveSteps, type AgentMessage, type LiveStep } from '../agent-shared'
import { messagesReducer } from './messages-reducer'
import { consumePendingOpenConversation, OPEN_CONVERSATION_EVENT, type OpenConversationDetail } from '../../../utils/palette-nav'

/**
 * 运行中排队的一条消息（V4-Iter-238）。
 * 只在渲染层内存里，**不落库、不进 store**：刷新页面就没了。这是有意的——
 * 排队项既不是消息也不是任务，把它持久化就得引入第三种存储形状，而它的全部价值在"这一轮跑完接着说"。
 */
export interface AgentQueueItem {
  /** 渲染层生成的本地 id，随插队请求交给引擎，再原样回到 step 事件里（对账用） */
  clientRef: string
  /** 排队项属于哪条会话：切会话不丢，切回来还在条上 */
  conversationId: string
  text: string
  /**
   * true = 已经交给引擎、等它在下个步边界收下。
   * 只有 `interject` 事件能把它消掉；运行结束（DONE/ERROR）时还挂着的一律视为**没送到**，
   * 退回排队等自动发送——宁可重发一次，也不能让用户那句话凭空消失。
   */
  interjecting: boolean
}

/** 排队条上限：再多就不是"补一句"而是"批量灌"了，那种场景应该等运行结束再发 */
export const MAX_QUEUE_ITEMS = 20

export function useAgentChat(providers: ProviderRecord[], assistants?: AssistantRecord[]) {
  const { t } = useI18n()
  const toast = useToast()
  const [assistantId, setAssistantId] = useState('')
  const [conversations, setConversations] = useState<import('../../../../../shared/types').ConversationRecord[]>([])
  const [archivedConversations, setArchivedConversations] = useState<import('../../../../../shared/types').ConversationRecord[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, dispatch] = useReducer(messagesReducer, [] as AgentMessage[])
  const [running, setRunning] = useState(false)
  const [interrupted, setInterrupted] = useState(false) // 上次运行被中止/出错（可断点恢复）
  const [runStats, setRunStats] = useState<AgentRunStats | null>(null) // 当前会话最近一次运行统计（trace 持久化，切回/刷新后恢复）
  const [sessionStats, setSessionStats] = useState<AgentSessionStats | null>(null) // 当前会话累计统计（跨全部运行）
  const [latestTraces, setLatestTraces] = useState<AgentTraceRecord[] | null>(null) // 最近一次运行分步明细（null=未懒加载）
  const [tracesLoading, setTracesLoading] = useState(false)
  /**
   * §235：当前这条会话的身份读数。三种状态各有脸：
   *  · `loading` —— 还没读到（新路径才走这一档：命令面板/恢复）⇒ 与今天一样能发；
   *  · `ok` 且 record 带父 ⇒ 这是**子代理会话**，只读；
   *  · `failed` —— 读不到身份 ⇒ 也按只读处理，并说清楚为什么。宁可输入框暂时消失，
   *    也不让人把消息发进一条机器会话：那种 run 的步骤不进父的 token 汇总（§163 口径），
   *    发出去的钱与产物都看不见。
   */
  const [subSessionIdentity, setSubSessionIdentity] = useState<
    { state: 'loading' } | { state: 'ok'; record: ConversationRecord | null } | { state: 'failed'; reason: string }
  >({ state: 'loading' })
  /** 当前会话的直接子会话（「子代理会话」那格列表；读失败时保持空，另有一句 unread 的话） */
  const [subSessions, setSubSessions] = useState<ConversationRecord[]>([])
  const [subSessionsUnread, setSubSessionsUnread] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState(0) // 当前运行正在执行的步数（running 时显示，结束后丢弃）
  /** 零调用提示：本次运行有工具可用但模型未调用任何工具时显示 */
  const [noToolCallNotice, setNoToolCallNotice] = useState(false)
  /** 本次运行被「'*' 只给内置」挡下的 MCP 工具数（随 DONE 事件回传，附在零调用提示里） */
  const [mcpHeldBack, setMcpHeldBack] = useState(0)
  /** 被用户点名「走文本协议」的模型键（`providerId::model`）；开关存 app_config，跨重启保留 */
  const [textProtocolModels, setTextProtocolModels] = useState<string[]>([])
  /** §234：每台模型声明的上下文窗口（键同上，值是 token 数）。表里没有=未设=按 30 条 */
  const [modelWindows, setModelWindows] = useState<Record<string, number>>({})
  /** 那一读失败过：界面不许把"没读到"演成"没有一台模型设过窗口"（§222 那一族） */
  const [modelWindowsUnread, setModelWindowsUnread] = useState<string | null>(null)
  /** 运行中实时步骤条 chip 流（done/error/切会话清空；不打 messages-reducer，避免污染消息流） */
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const requestIdRef = useRef('')
  // 事件订阅闭包内读取当前会话（effect 仅依赖 [t]，不能直接用 conversationId state）
  const conversationIdRef = useRef<string | null>(null)
  conversationIdRef.current = conversationId

  /**
   * 运行中排队消息（V4-Iter-238）。三个 ref 是同一件事的三个侧面——事件回调只有**首帧闭包**，
   * 读 state 会读到过期值，而过期值在这条链上会直接造成重复消息：
   *  · `runningRef`：`send()` 里的 `running` 挡板改用 ref，否则 DONE 回调里刚发起来的新一轮
   *    会被上一次渲染的 `running=true` 挡回去（自动发送静默失效）；
   *  · `queueRef`：队列的同步镜像，所有写入都走 `writeQueue`，让同一次回调里的"先归位再自动发"看得见；
   *  · `sendRef`/`canStartRunRef`：DONE 回调要发下一条，而 send 的入参（模型/会话）必须取当前渲染的值。
   */
  const [queue, setQueue] = useState<AgentQueueItem[]>([])
  const queueRef = useRef<AgentQueueItem[]>(queue)
  const runningRef = useRef(false)
  const sendRef = useRef<(text: string, attachments: ChatAttachment[]) => void>(() => {})
  const canStartRunRef = useRef<() => boolean>(() => false)

  /** running 的唯一写入口：ref 与 state 同步走，回调里读 runningRef 才拿得到"此刻" */
  const setRunningNow = (v: boolean): void => {
    runningRef.current = v
    setRunning(v)
  }

  /** 队列的唯一写入口：ref 与 state 同步走，同一次回调里"先归位再自动发"才看得见新列表 */
  const writeQueue = (next: AgentQueueItem[]): void => {
    queueRef.current = next
    setQueue(next)
  }

  /**
   * 把一句话放进**当前会话**的排队条。返回本地 clientRef，空串表示没放进去（文本为空／没有会话／条满）。
   * 条满要说出来：按下入队的人以为那句话已经在路上，静默丢掉等于骗人。
   */
  const pushQueueItem = (text: string, interjecting: boolean): string => {
    const content = text.trim()
    const convId = conversationIdRef.current
    if (!content || !convId) return ''
    const forThisConv = queueRef.current.filter((q) => q.conversationId === convId)
    if (forThisConv.length >= MAX_QUEUE_ITEMS) {
      toast.error(t('agent.queue.tooMany', { max: MAX_QUEUE_ITEMS }))
      return ''
    }
    const clientRef = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    writeQueue([...queueRef.current, { clientRef, conversationId: convId, text: content, interjecting }])
    return clientRef
  }

  /** 「入队」：等这一轮跑完自动发出（中止/出错时不自动发，见 settleQueueAfterRun） */
  const enqueueText = (text: string): void => {
    pushQueueItem(text, false)
  }

  /**
   * 把一条排队项交给正在运行的主干 run（引擎只在下个步边界收下）。
   * 这里"成功"只等于"引擎接了这条请求"，**不等于**它已进这一轮：真正的凭据是随后那条
   * 带同一个 clientRef 的 `interject` 事件。所以成功分支什么都不做——
   * 划掉排队项由事件负责，运行结束时还挂着的一律按"没送到"归回队列。
   */
  const requestInterject = (clientRef: string, text: string): void => {
    const backToQueue = (msg?: IpcFailureInput): void => {
      writeQueue(queueRef.current.map((q) => (q.clientRef === clientRef ? { ...q, interjecting: false } : q)))
      if (msg) toast.error(ipcFailureText(msg, t) || t('agent.unknownError'))
    }
    const requestId = requestIdRef.current
    // 还没有 requestId（发送请求本身尚在路上）：归回队列等自动发送，不报错误
    if (!requestId) {
      backToQueue()
      return
    }
    void window.pocketai
      .interjectAgent({ requestId, clientRef, text })
      .then((r) => {
        if (hasIpcFailed(r)) backToQueue(r)
      })
      .catch((e) => {
        reportIpcError('agent.interjectAgent')(e)
        backToQueue()
      })
  }

  /** 「立即插队」：先进条（看得见），再交给引擎；接不住就留在条上当普通排队项 */
  const interjectText = (text: string): void => {
    const content = text.trim()
    const clientRef = pushQueueItem(content, true)
    if (!clientRef) return
    requestInterject(clientRef, content)
  }

  /** 撤掉一条还没发出去的排队消息（只动内存，DB 里从来没有它） */
  const dropQueued = (clientRef: string): void => {
    writeQueue(queueRef.current.filter((q) => q.clientRef !== clientRef))
  }

  /** 排队条上的「发送」：运行中就插队，空闲时当成一条正常消息发出去 */
  const sendQueuedNow = (clientRef: string): void => {
    const item = queueRef.current.find((q) => q.clientRef === clientRef)
    if (!item || item.interjecting) return
    if (runningRef.current) {
      writeQueue(queueRef.current.map((q) => ({ ...q, interjecting: q.clientRef === clientRef ? true : q.interjecting })))
      requestInterject(clientRef, item.text)
      return
    }
    if (!canStartRunRef.current()) return
    writeQueue(queueRef.current.filter((q) => q.clientRef !== clientRef))
    sendRef.current(item.text, [])
  }

  /**
   * 一轮结束后的收尾（V4-Iter-238），两件事：
   *  ① 还挂着"已交给引擎"的项归回排队——没收到 `interject` 事件就是没落库。
   *     不归回的话它会永远停在"插队中"，既不上屏也不自动发，用户那句话就消失了；
   *  ② 只有**正常跑完**且当前正看着这条会话时才自动发出下一条。中止/出错不自动发：
   *     按停止就是要停下来看结果，紧跟一条自动发送等于没停；而后台会话的排队项要等用户切回来
   *     再发——`send` 发的是"当前看着的会话"，在后台回调里发就是把话塞进别的会话。
   */
  const settleQueueAfterRun = (convId: string, autoSend: boolean): void => {
    const settled = queueRef.current.map((q) =>
      q.conversationId === convId && q.interjecting ? { ...q, interjecting: false } : q
    )
    writeQueue(settled)
    if (!autoSend) return
    const next = settled.find((q) => q.conversationId === convId && !q.interjecting)
    if (!next || !canStartRunRef.current()) return
    writeQueue(settled.filter((q) => q.clientRef !== next.clientRef))
    sendRef.current(next.text, [])
  }

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId]
  )

  // 服务商列表的镜像：让 applyLastModelOf 保持**稳定身份**——它一旦进了会话列表 effect 的依赖，
  // providers 每次换引用都会重跑那个 effect，于是「切回 Agent 模块」就把用户正开着的会话
  // 跳回「最近一条」（列表现在会在切回时重拉，见 useProviderData）。
  const providersRef = useRef(providers)
  providersRef.current = providers

  /**
   * 选中项必须跟着"当前服务商列表"走：列表会在切回本模块时重拉（设置里删了/停用了服务商、
   * 或拉取模型后清单变了），而 providerId/model 是本地 state，不清就会留下
   * 「canSend 为真、请求却发给一个不存在的服务商/模型」，且模型栏因选不到项而整块消失。
   */
  useEffect(() => {
    if (!providerId) return
    const p = providers.find((x) => x.id === providerId)
    if (!p) {
      setProviderId('')
      setModel('')
      return
    }
    if (model && p.models.length > 0 && !p.models.includes(model)) setModel('')
  }, [providers, providerId, model])

  // 文本协议开关的当前状态：清单在挂载时读一次，之后以 set 通道回传的最新值为准
  useEffect(() => {
    void window.pocketai
      .getAgentTextProtocol()
      .then((list) => { if (!hasIpcFailed(list)) setTextProtocolModels(Array.isArray(list) ? list : []) })
      .catch(reportIpcError('agent.getTextProtocol'))
  }, [])

  /** 当前选中的 provider+model 是否已被点名走文本协议 */
  const textProtocolForced =
    !!providerId && !!model && textProtocolModels.includes(`${providerId}::${model}`)

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
  const contextWindowTokens =
    providerId && model ? modelWindows[modelWindowKey(providerId, model)] ?? null : null

  /**
   * 设/清当前这台模型的窗口（下一轮运行生效）。
   * 三条失败面各说各的：IPC 失败⇒原因；服务层回码拒绝⇒那句"这个数不行"（数字取自共享常量，
   * 不手抄）；两者都不做本地乐观更新——表以库里回传的为准。
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

  /** 开/关当前这台模型的文本协议（下一轮运行生效；不做本地乐观更新，以库里回传的清单为准） */
  const setTextProtocol = useCallback(
    (on: boolean) => {
      if (!providerId || !model) return
      void window.pocketai
        .setAgentTextProtocol(providerId, model, on)
        .then((list) => {
          // §221：这是用户点的那一下，失败必须说话。原来那句 `Array.isArray(list) ? list : []`
          // 会把 `{ok:false}` 咽成空清单 ⇒ 按钮自己变回「文本协议」，看起来像"关掉了"
          if (hasIpcFailed(list)) {
            toast.error(ipcFailText(list, t('agent.unknownError')))
            return
          }
          setTextProtocolModels(Array.isArray(list) ? list : [])
        })
        .catch(reportIpcError('agent.setTextProtocol'))
    },
    [providerId, model]
  )

  /**
   * 回填某会话最后使用的 Provider/模型：会话记录的 modelLabel 优先
   * （老会话/未带 label 时回落读消息列表，取最后一条 assistant 的 provider/model）。
   * 点击历史与自动选中（含上次会话恢复）共用这一条，避免出现"会话回来了、模型下拉是空的"。
   */
  const applyLastModelOf = useCallback(
    (id: string, label?: string | null) => {
      // 格式："providerId:model" / 多目标 "pid1:m1 | pid2:m2" / Agent "agent:pid:model"
      const first = (label ?? '').split('|')[0]?.trim() ?? ''
      const rest = first.startsWith('agent:') ? first.slice(6) : first
      const i = rest.indexOf(':')
      if (i > 0) {
        const pid = rest.slice(0, i)
        const mdl = rest.slice(i + 1)
        const p = providersRef.current.find((x) => x.id === pid)
        if (p) {
          setProviderId(pid)
          setModel(p.models.includes(mdl) ? mdl : '')
          return
        }
      }
      void window.pocketai
        .listMessages(id)
        .then((msgs) => {
          if (hasIpcFailed(msgs)) return
          for (let k = msgs.length - 1; k >= 0; k--) {
            const m = msgs[k]
            if (!m) continue
            if (m.role === 'assistant' && m.provider && m.model) {
              const p = providersRef.current.find((x) => x.id === m.provider)
              if (p) {
                setProviderId(m.provider)
                setModel(p.models.includes(m.model) ? m.model : '')
              }
              break
            }
          }
        })
        .catch(reportIpcError('agent.restoreLastModel'))
    },
    []
  )

  /**
   * 「上次用在哪」：模块保活有上限（4 个，超出按 LRU 休眠卸载），加上重启与休眠后重挂，
   * 助手与会话的选中态都会丢——模块内部状态不跨实例保存，切回来等于从零开始。
   * 这里从 ui 偏好读回（存 app_config，属合并时的 LOCAL_KEEP 表 ⇒ 不会被另一台机器搬来），
   * 之后每次真正确定选中项就写回。restoreRef 只用一次：切助手后不该再套旧会话。
   */
  const restoreRef = useRef<{ assistantId: string; conversationId: string } | null>(null)
  const [restored, setRestored] = useState(false)

  // 首屏 provider/助手还在路上（useProviderData 的 Promise.all 一次到货）；
  // 空数组会被当成"没有存档目标"，所以等它们到齐再读存档、再允许写回。
  const dataReady = providers.length > 0 || (assistants?.length ?? 0) > 0

  useEffect(() => {
    if (!dataReady) return
    let cancelled = false
    void window.pocketai
      .getUiPrefs()
      .then((p) => {
        if (hasIpcFailed(p)) return
        if (cancelled) return
        const a = typeof p?.data?.agentAssistantId === 'string' ? p.data.agentAssistantId : ''
        const c = typeof p?.data?.agentConversationId === 'string' ? p.data.agentConversationId : ''
        restoreRef.current = { assistantId: a, conversationId: c }
        if (a) setAssistantId(a)
      })
      .catch(reportIpcError('agent.getUiPrefs'))
      .finally(() => {
        if (!cancelled) setRestored(true)
      })
    return () => {
      cancelled = true
    }
  }, [dataReady])

  useEffect(() => {
    if (!restored) return
    // 加载中间态（还没定下助手/会话）不写，否则会把上次的存档清掉
    if (!assistantId || !conversationId) return
    void window.pocketai
      .setUiPrefs({ agentAssistantId: assistantId, agentConversationId: conversationId })
      .then((r) => {
        // 该通道成功也返回 {ok:true,data} 信封，不能用 isIpcFail 判别
        if (r.ok === false) logIpcError('agent.setUiPrefs', r.error ?? 'failed')
      })
      .catch(reportIpcError('agent.setUiPrefs'))
  }, [restored, assistantId, conversationId])

  // 恢复来的助手必须仍然存在（助手可能被删除或被导入覆盖）；不在列表里就清回自由会话，
  // 并把存档一起抹掉——否则每次进来都要重演一遍"选中一个不存在的助手"
  useEffect(() => {
    if (!restored || !assistants || assistants.length === 0) return
    if (!assistantId || assistants.some((a) => a.id === assistantId)) return
    setAssistantId('')
    setConversationId(null)
    restoreRef.current = null
    void window.pocketai
      .setUiPrefs({ agentAssistantId: '', agentConversationId: '' })
      .then((r) => {
        if (r.ok === false) logIpcError('agent.setUiPrefs', r.error ?? 'failed')
      })
      .catch(reportIpcError('agent.setUiPrefs'))
  }, [restored, assistants, assistantId])

  // 助手切换 → 拉活跃+归档会话列表并自动选中最近一次（活跃列表已按置顶权重+updated_at DESC 排序）
  useEffect(() => {
    if (!assistantId) return
    let cancelled = false
    void Promise.all([
      window.pocketai.listConversations(assistantId, true, false),
      window.pocketai.listConversations(assistantId, true, true)
    ]).then(([list, archived]) => {
      if (cancelled) return
      setConversations(list)
      setArchivedConversations(archived)
      // 待恢复的会话必须属于这个助手，否则视为失效（被删/跨助手残留）
      const want =
        restoreRef.current && restoreRef.current.assistantId === assistantId
          ? restoreRef.current.conversationId
          : ''
      const restoredHit = want ? list.find((x) => x.id === want) : undefined
      restoreRef.current = null
      // 命令面板跨助手跳来：pending 指定会话优先于「恢复上次」与「自动选最近」（助手不匹配保留 pending）
      const pending = consumePendingOpenConversation(true, assistantId)
      const findConv = (id: string) => list.find((x) => x.id === id) ?? archived.find((x) => x.id === id)
      let chosenId: string | null = null
      let chosenLabel: string | null | undefined
      if (pending?.conversationId && pending.assistantId === assistantId) {
        chosenId = pending.conversationId
        chosenLabel = findConv(chosenId)?.modelLabel
      } else if (restoredHit) {
        chosenId = restoredHit.id
        chosenLabel = restoredHit.modelLabel
      } else if (list.length > 0) {
        chosenId = list[0]!.id
        chosenLabel = list[0]!.modelLabel
      }
      setConversationId(chosenId)
      if (chosenId) applyLastModelOf(chosenId, chosenLabel)
    }).catch(reportIpcError('agent.listConversations'))
    return () => { cancelled = true }
  }, [assistantId])

  // 命令面板导航（同助手直接开会话；跨助手交助手切换 effect 消费 pending）
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<OpenConversationDetail>).detail
      if (!d || !d.isAgent) return
      if (d.assistantId && d.assistantId !== assistantId) {
        setAssistantId(d.assistantId) // 助手 effect 重新拉列表时消费 pending
        return
      }
      consumePendingOpenConversation(true, assistantId) // 同助手：清掉 pending 防残留
      if (d.conversationId) setConversationId(d.conversationId)
    }
    window.addEventListener(OPEN_CONVERSATION_EVENT, handler)
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, handler)
  }, [assistantId])


  /**
   * §235 两件事各读各的：这条会话的身份（是不是某次委派出来的）、它自己派出去过哪几趟。
   * 为什么读数据而不是记「用户从哪儿点进来的」：命令面板那条路（`OPEN_CONVERSATION_EVENT`）会绕过
   * 一切导航状态，只靠入口判「能不能发」迟早漏一条；而父 id 本来就是 conversations 表上的一列。
   * 两条读各自失败各自说一句，不合并成一句"读不到"（失败面不同，接管也不同）。
   */
  const loadSubSessionReads = useCallback(() => {
    const convId = conversationIdRef.current
    if (!convId) {
      setSubSessionIdentity({ state: 'ok', record: null })
      setSubSessions([])
      setSubSessionsUnread(null)
      return
    }
    void window.pocketai
      .getConversation(convId)
      .then((rec) => {
        if (conversationIdRef.current !== convId) return
        if (hasIpcFailed(rec)) {
          setSubSessionIdentity({ state: 'failed', reason: ipcFailText(rec, t('agent.unknownError')) })
          return
        }
        setSubSessionIdentity({ state: 'ok', record: rec ?? null })
      })
      .catch((e) => {
        // reject 那一半也要有脸：只 report 不接管会把身份永久卡在 loading
        reportIpcError('agent.getConversation')(e)
        if (conversationIdRef.current === convId) setSubSessionIdentity({ state: 'failed', reason: errText(e) })
      })
    void window.pocketai
      .listChildConversations(convId)
      .then((list) => {
        if (conversationIdRef.current !== convId) return
        if (hasIpcFailed(list)) {
          // 读不到不能咽成空列表——空列表在界面上和"这条会话没派过子代理"长得一模一样（§222 那一族）
          setSubSessionsUnread(ipcFailText(list, t('agent.unknownError')))
          return
        }
        setSubSessionsUnread(null)
        setSubSessions(Array.isArray(list) ? list : [])
      })
      .catch((e) => {
        reportIpcError('agent.listChildConversations')(e)
        if (conversationIdRef.current === convId) setSubSessionsUnread(errText(e))
      })
  }, [t])

  /**
   * 「这一笔身份我在点下去的那一刻就已经知道了」（点开子会话／返回上一级各写一次）。
   * 为什么不只写 state：换会话那条 effect 会把身份复位成 `loading`，而**只读判据不含 loading**——
   * 于是点开的下一帧输入框会闪回来一下（发得快的人真按得下去）。ref 让那次复位认得这次跳转。
   */
  const knownIdentityRef = useRef<{ id: string; record: ConversationRecord | null } | null>(null)

  // 换会话就重读这两件事（独立成一条 effect：语言切换只让取词函数变，不该把消息与统计重拉一遍）
  useEffect(() => {
    const known = knownIdentityRef.current
    knownIdentityRef.current = null
    setSubSessionIdentity(
      known && known.id === conversationId ? { state: 'ok', record: known.record } : { state: 'loading' }
    )
    setSubSessions([])
    setSubSessionsUnread(null)
    loadSubSessionReads()
  }, [conversationId, loadSubSessionReads])

  /** 正在看的子代理会话（null=不是子会话或还没读到） */
  const subSession = subSessionIdentity.state === 'ok' && subSessionIdentity.record?.parentConversationId
    ? subSessionIdentity.record
    : null
  /** 身份读不到的那句话（界面据此显示只读条＋重试，而不是假装这条会话能发） */
  const identityUnread = subSessionIdentity.state === 'failed' ? subSessionIdentity.reason : null
  /**
   * 只读判据（一处派生，六处接管：输入区整块、卡片上的删除／截断重跑／重新生成／右键提醒、断点恢复那条）。
   * `loading` 不在内：那一档只出现在"没有任何本地线索"的入口，且和用户敲下回车之间是几毫秒，
   * 把它算进去会让每次切会话都闪一次输入框。
   */
  const subSessionReadonly =
    subSessionIdentity.state === 'failed' || (subSessionIdentity.state === 'ok' && !!subSessionIdentity.record?.parentConversationId)

  /** 打开某趟子代理的独立会话：本地已有那条记录，直接写进身份，避免"先能输入再变只读"的那一帧 */
  const openSubSession = (id: string) => {
    const rec = subSessions.find((x) => x.id === id) ?? null
    setConversationId(id)
    if (rec) {
      knownIdentityRef.current = { id, record: rec }
      setSubSessionIdentity({ state: 'ok', record: rec })
    }
    applyLastModelOf(id, rec?.modelLabel)
  }

  /** 回到派出它的那条会话（父一定在会话列表里，模型选择照 selectConversation 同一条路回填） */
  const backToParentConversation = () => {
    const parentId = subSession?.parentConversationId
    if (!parentId) return
    const c = conversations.find((x) => x.id === parentId) ?? archivedConversations.find((x) => x.id === parentId) ?? null
    setConversationId(parentId)
    knownIdentityRef.current = { id: parentId, record: c }
    setSubSessionIdentity({ state: 'ok', record: c })
    applyLastModelOf(parentId, c?.modelLabel)
  }

  useEffect(() => {
    setInterrupted(false)
    setRunStats(null)
    setSessionStats(null)
    setLatestTraces(null)
    setTracesLoading(false)
    setLiveSteps([])
    setNoToolCallNotice(false)
    setMcpHeldBack(0)
    if (!conversationId) {
      dispatch({ type: 'clear' })
      return
    }
    void window.pocketai.listMessages(conversationId).then((dbMsgs: MessageRecord[]) => {
      if (hasIpcFailed(dbMsgs)) return
      dispatch({ type: 'load', messages: toAgentMessages(dbMsgs) })
    }).catch(reportIpcError('agent.listMessages'))
    // 恢复该会话最近一次运行统计（trace 持久化，刷新/切回仍可见）；
    // 快速切会话时用 ref 丢弃迟到响应，避免旧会话统计覆盖当前会话
    void window.pocketai.getLatestRunStats(conversationId).then((stats) => {
      if (hasIpcFailed(stats)) return
      if (conversationIdRef.current === conversationId) setRunStats(stats)
    }).catch(reportIpcError('agent.getLatestRunStats'))
    // 加载会话累计统计（跨全部运行聚合）
    void window.pocketai.getSessionStats(conversationId).then((stats) => {
      if (hasIpcFailed(stats)) return
      if (conversationIdRef.current === conversationId) setSessionStats(stats)
    }).catch(reportIpcError('agent.getSessionStats'))
  }, [conversationId])

  // 订阅 Agent 流式事件（归属见下面两条判据）
  useEffect(() => {
    const offs: Array<() => void> = []
    /**
     * 两条归属判据，各挡一种真实串台（两种形状都在 tests/agent-event-attribution 里挂了用例）：
     *  · `requestId` —— 中止后立刻重发：上一轮的**迟到 chunk** 会写进同一会话里那张已定稿的
     *    旧卡（reducer 按 messageId 找卡片，旧卡还留在 messages 里 ⇒ 只有 requestId 挡得住）；
     *  · `conversationId` —— 运行中切会话：上一轮的 tool 卡会被 append 进**当前看着的**那条会话，
     *    而这些卡没有 DB 记录，切走再切回才"消失"，用户看到的就是凭空多出来的消息。
     * `running` 只按 requestId 判，不加会话条件：它是模块级的"有没有运行在跑"总闸，
     * 会话一参与就把迟到 DONE 丢掉，用户切过去就再也解不开输入框。
     */
    const fromThisRun = (requestId: string): boolean => requestId === requestIdRef.current
    const thisRunShownNow = (e: { requestId: string; conversationId: string }): boolean =>
      fromThisRun(e.requestId) && e.conversationId === conversationIdRef.current

    offs.push(
      window.pocketai.onAgentStep((e: AgentStepEvent) => {
        /**
         * 插队对账（V4-Iter-238）放在会话判据**之前**：clientRef 是全局唯一的本地 id，
         * 这句话已经被引擎落库这件事与"用户现在看着哪条会话"无关。
         * 若按 thisRunShownNow 把关，切走会话时这条对账会被丢掉，运行结束就会把同句话
         * 当成"没送到"再发一遍——库里凭空多一条重复消息。
         */
        if (e.type === 'interject' && e.clientRef && fromThisRun(e.requestId)) {
          const rest = queueRef.current.filter((q) => q.clientRef !== e.clientRef)
          if (rest.length !== queueRef.current.length) writeQueue(rest)
        }
        if (!thisRunShownNow(e)) return
        setCurrentStep(e.stepIndex)
        setLiveSteps((prev) => reduceLiveSteps(prev, e))
        dispatch({ type: 'step', event: e, unknownErrorText: t('agent.unknownError') })
      })
    )
    offs.push(
      window.pocketai.onAgentChunk((e: AgentChunkEvent) => {
        if (!fromThisRun(e.requestId)) return
        dispatch({ type: 'chunk', messageId: e.messageId, delta: e.delta, reasoning: e.reasoning })
      })
    )
    offs.push(
      window.pocketai.onAgentDone((e: AgentDoneEvent) => {
        if (!fromThisRun(e.requestId)) return
        setRunningNow(false)
        setCurrentStep(0)
        setLiveSteps([])
        // 排队条收尾：见 settleQueueAfterRun。自动发送只在正看着这条会话时发生
        settleQueueAfterRun(e.conversationId, e.conversationId === conversationIdRef.current)
        // 仅在事件仍归属当前会话时展示统计与复位（切会话后迟到的 DONE 不覆盖）
        if (e.conversationId === conversationIdRef.current) {
          setInterrupted(false)
          setRunStats(e.traceStats ?? null)
          // 零调用提示：有工具可用但未调用任何工具
          setNoToolCallNotice(e.usedTools === false)
          setMcpHeldBack(e.mcpHeldBack ?? 0)
          // 把知识库引用来源挂到最终回答卡片（流式结束即时显示，无需 reload）
          if (e.sources?.length) {
            dispatch({ type: 'setSources', messageId: e.finalMessageId, sources: e.sources })
          }
          // 运行结束后刷新会话累计统计（本次运行已入库）
          void window.pocketai.getSessionStats(e.conversationId).then((stats) => {
            if (hasIpcFailed(stats)) return
            if (conversationIdRef.current === e.conversationId) setSessionStats(stats)
          }).catch(reportIpcError('agent.getSessionStats'))
        }
      })
    )
    offs.push(
      window.pocketai.onAgentError((e: AgentErrorEvent) => {
        if (!fromThisRun(e.requestId)) return
        setRunningNow(false)
        setCurrentStep(0)
        setLiveSteps([])
        // 中止/出错：插队中的项归回队列，但**不**自动发下一条（用户要停下来看，见 settleQueueAfterRun ②）
        settleQueueAfterRun(e.conversationId, false)
        // 「可断点恢复」是按会话讲的：正在看别的会话时不该被上一轮的失败点亮
        if (e.conversationId === conversationIdRef.current) setInterrupted(true)
      })
    )
    // 智能标题后台生成完成：就地更新活跃/归档两个列表（done 后 reload 为兜底）
    offs.push(
      window.pocketai.onConversationTitle(({ conversationId, title }) => {
        const patch = (c: { id: string }) => (c.id === conversationId ? { title } : {})
        setConversations((prev) => prev.map((c) => ({ ...c, ...patch(c) })))
        setArchivedConversations((prev) => prev.map((c) => ({ ...c, ...patch(c) })))
      })
    )
    return () => offs.forEach((off) => off())
  }, [t])

  // safeHandle 把失败转成 resolve 的 {ok:false}：这一族里不判就是"界面多出一条库里没有的会话"
  // 或"库里还在的会话从列表消失"（对话页的同一操作靠 reloadConversations 自纠，两个入口形状不同，§215 收敛）
  const failOp = (r: unknown): boolean => {
    if (!hasIpcFailed(r)) return false
    toast.error(ipcFailText(r, t('agent.unknownError')))
    return true
  }

  const newConversation = async () => {
    if (!assistantId) return
    const c = await window.pocketai.createConversation(assistantId)
    if (failOp(c)) return
    setConversations((prev) => [c, ...prev])
    setConversationId(c.id)
  }

  // 删除历史会话（与对话页行为一致：无二次确认）
  const deleteConversation = async (id: string) => {
    const r = await window.pocketai.deleteConversation(id)
    if (failOp(r)) return
    setConversations((prev) => prev.filter((c) => c.id !== id))
    setArchivedConversations((prev) => prev.filter((c) => c.id !== id))
    if (conversationId === id) setConversationId(null)
  }

  // 重命名会话（本地同步更新两列表，无需整表刷新）
  const renameConversation = async (id: string, title: string) => {
    const r = await window.pocketai.renameConversation(id, title)
    if (failOp(r)) return
    const patch = (c: { id: string }) => (c.id === id ? { title } : {})
    setConversations((prev) => prev.map((c) => ({ ...c, ...patch(c) })))
    setArchivedConversations((prev) => prev.map((c) => ({ ...c, ...patch(c) })))
  }

  // 置顶/取消置顶：重新拉取保证排序权重生效
  const toggleConversationPinned = async (id: string, pinned: boolean) => {
    const r = await window.pocketai.setConversationPinned(id, pinned)
    if (failOp(r)) return
    await reloadConversations()
  }

  // 归档/取消归档：重新拉取活跃与归档两列表
  const setConversationArchivedState = async (id: string, archived: boolean) => {
    const r = await window.pocketai.setConversationArchived(id, archived)
    if (failOp(r)) return
    await reloadConversations()
  }

  // 重新拉取当前助手的活跃+归档会话列表（导入/归档操作后用；不改变当前选中）
  const reloadConversations = useCallback(async () => {
    if (!assistantId) return
    try {
      const [list, archived] = await Promise.all([
        window.pocketai.listConversations(assistantId, true, false),
        window.pocketai.listConversations(assistantId, true, true)
      ])
      setConversations(list)
      setArchivedConversations(archived)
    } catch (e) {
      reportIpcError('agent.reloadConversations')(e)
    }
  }, [assistantId])

  // 删除单条消息：本地先行移除（tool call/result 配对卡由 reducer 一并清理），有 dbId 再删 DB
  // 用 ref 读 messages 保持 callback 引用稳定（AgentMessageCard 是 memo，引用变化会使全部卡片失去 memo 优化）
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const deleteMessage = useCallback(async (id: string) => {
    const target = messagesRef.current.find((m) => m.id === id)
    dispatch({ type: 'delete', id })
    if (target?.dbId) {
      // §223：本地 dispatch 已经把那条从视图里拿掉了，`.catch(reportIpcError)` 又接不到 resolve 的失败
      // ⇒ "删掉了"而库里还在，重开会话它又回来，且一句 explanation 都没有。失败要说出来（与同文件 failOp 同口径）
      const r = await window.pocketai.deleteMessage(target.dbId).catch(reportIpcError('agent.deleteMessage'))
      failOp(r)
    }
  }, [])

  // 点击历史会话 → 自动回填该会话最后使用的 Provider/模型（含归档区会话）
  const selectConversation = (id: string) => {
    setConversationId(id)
    const c = conversations.find((x) => x.id === id) ?? archivedConversations.find((x) => x.id === id)
    applyLastModelOf(id, c?.modelLabel)
  }

  /** 切换 Provider 时清空模型选择 */
  const changeProvider = (id: string) => {
    setProviderId(id)
    setModel('')
  }

  const canSend = !!providerId && !!model && !!conversationId && !!assistantId

  /** 懒加载当前会话最近一次运行的分步明细（展开统计条时调用；带快速切会话竞态防护） */
  const loadLatestTraces = useCallback(() => {
    const convId = conversationIdRef.current
    if (!convId) return
    setTracesLoading(true)
    void window.pocketai.getLatestRunTraces(convId).then((traces) => {
      // §221：失败只跳过"写数据"这一半，setTracesLoading(false) 照跑（与下面那个 .catch 同形）；
      // 整条早退会把统计条永久卡在加载态
      if (conversationIdRef.current === convId) {
        if (!hasIpcFailed(traces)) setLatestTraces(traces)
        setTracesLoading(false)
      }
    }).catch((e) => {
      reportIpcError('agent.getLatestRunTraces')(e)
      if (conversationIdRef.current === convId) setTracesLoading(false)
    })
  }, [])

  /**
   * 能不能起一轮新运行。**判据与下面 send 的挡板逐字一致**，且走 runningRef 而不是 running state：
   * DONE 回调里刚 setRunningNow(false) 之后马上要发下一条排队消息，那一帧的 `running` 还是 true，
   * 用 state 判会让自动发送静默失效（消息留在条上，看起来像"没反应"）。
   * send 自己不复用它，是因为这里的函数式判断不 narrowing `conversationId: string | null`，
   * 复用会把 null 塞进 IPC 载荷——两处判据靠注释同轴，改一处要改两处。
   */
  const canStartRun = (): boolean => !!providerId && !!model && !!conversationId && !runningRef.current
  canStartRunRef.current = canStartRun

  const send = (text: string, attachments: ChatAttachment[]) => {
    const content = text.trim()
    if (!content || !providerId || !model || !conversationId || runningRef.current) return
    const requestId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    requestIdRef.current = requestId

    // 立即插入用户消息到 UI
    dispatch({
      type: 'append',
      message: { id: `u_${Date.now()}`, role: 'user', text: content, attachments: [...attachments] }
    })
    setRunningNow(true)
    setInterrupted(false)
    setRunStats(null) // 新一轮运行：清除上轮统计，待 DONE 事件更新
    setLatestTraces(null) // 旧分步明细失效，下次展开重新拉取
    setCurrentStep(0)

    // safeHandle 把 chat:send 的抛错转成 {ok:false} **返回值**而不是 rejection，
    // 而 resume/rerun 这两个内部入口拿的是浮动 promise ⇒ 收口必须放在 send 里，四个入口才都接得住（V4-Iter-204）。
    const fail = (msg: IpcFailureInput): void => {
      setRunningNow(false)
      setCurrentStep(0)
      setLiveSteps([])
      toast.error(chatSendFailureText(msg, t) || t('agent.unknownError'))
    }
    return window.pocketai
      .sendMessage({
        requestId,
        conversationId,
        assistantId: assistantId || null,
        content,
        targets: [{ providerId, model }],
        agentMode: true,
        attachments: attachments.length > 0 ? attachments : undefined,
        kbRefs: attachments.filter((a) => a.type === 'kb').map((a) => a.kbId).filter(Boolean) as string[]
      })
      .then((r) => {
        if (hasIpcFailed(r)) fail(r)
      })
      .catch((e) => fail(errText(e, t('agent.unknownError'))))
  }
  sendRef.current = send

  const abort = () => {
    if (requestIdRef.current) window.pocketai.abortAgent(requestIdRef.current)
    setRunningNow(false)
  }

  /** 断点恢复：中止/出错后一键续跑（消息历史已在 DB，LLM 基于完整上下文继续） */
  const resume = () => {
    return send(
      '请继续执行刚才未完成的任务：先简要回顾已完成的步骤和已获得的结果，然后从中断处继续执行剩余步骤。',
      []
    )
  }

  /**
   * 截断重跑：以某条历史用户消息为界，删除它及其后的全部消息（DB + UI），
   * 用文本与附件重新发起。Agent 为线性历史，不引入 Chat 的分支体系。
   * 仅对已持久化（有 dbId）的用户消息可用；DB 删除成功后才动 UI，失败仅记日志。
   * overrideText 非空时为「编辑后重发」：沿用附件，文本以编辑内容为准。
   */
  const rerun = async (id: string, overrideText?: string) => {
    if (running) return
    const target = messagesRef.current.find((m) => m.id === id)
    if (!target || target.role !== 'user' || !target.dbId || !target.text.trim()) return
    const text = overrideText?.trim() || target.text
    const attachments = target.attachments ?? []
    try {
      await window.pocketai.truncateMessagesFrom(target.dbId)
    } catch (e) {
      reportIpcError('agent.truncateMessagesFrom')(e)
      return
    }
    dispatch({ type: 'truncateFrom', id })
    send(text, attachments)
  }

  /** 重新生成某条助手回复：定位其前最近的可重跑用户消息后截断重跑 */
  const regenerate = (assistantId: string) => {
    const sourceId = findRerunSourceId(messagesRef.current, assistantId)
    if (sourceId) void rerun(sourceId)
  }

  /** 排队条只展示当前会话的项（别的会话的项留在内存里，切回去还在条上） */
  const visibleQueue = queue.filter((q) => q.conversationId === conversationId)

  return {
    assistantId,
    setAssistantId,
    conversations,
    archivedConversations,
    conversationId,
    messages,
    running,
    interrupted,
    runStats,
    sessionStats,
    latestTraces,
    tracesLoading,
    loadLatestTraces,
    currentStep,
    liveSteps,
    noToolCallNotice,
    setNoToolCallNotice,
    mcpHeldBack,
    textProtocolForced,
    setTextProtocol,
    contextWindowTokens,
    contextWindowUnread: modelWindowsUnread,
    setContextWindow,
    providerId,
    model,
    setModel,
    selectedProvider,
    canSend,
    newConversation,
    deleteConversation,
    renameConversation,
    toggleConversationPinned,
    setConversationArchivedState,
    reloadConversations,
    deleteMessage,
    selectConversation,
    subSession,
    identityUnread,
    subSessionReadonly,
    subSessions,
    subSessionsUnread,
    openSubSession,
    backToParentConversation,
    retrySubSessionReads: loadSubSessionReads,
    changeProvider,
    send,
    queue: visibleQueue,
    queueFull: visibleQueue.length >= MAX_QUEUE_ITEMS,
    enqueueText,
    interjectText,
    dropQueued,
    sendQueuedNow,
    abort,
    resume,
    rerun,
    regenerate
  }
}

export type AgentChat = ReturnType<typeof useAgentChat>
