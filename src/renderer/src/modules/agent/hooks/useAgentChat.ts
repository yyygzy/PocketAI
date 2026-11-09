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
import { useAgentModelExtras } from '../../chat/useAgentModelExtras'
import { chatSendFailureText, hasIpcFailed, ipcFailText, logIpcError, reportIpcError, type IpcFailureInput } from '../../../utils/ipc'
import { errText } from '../../../utils/error'
import { useToast } from '../../../components/ToastProvider'
import { findRerunSourceId, toAgentMessages, reduceLiveSteps, type AgentMessage, type LiveStep } from '../agent-shared'
import { messagesReducer } from './messages-reducer'
import {
  identityUnreadOf,
  isSubSessionReadonly,
  subSessionOf,
  type SubSessionIdentity
} from '../sub-session'
import { MAX_QUEUE_ITEMS, useAgentQueue } from '../../chat/useAgentQueue'
import { useZeroToolCallNotice } from '../../chat/useZeroToolCallNotice'
import { consumePendingOpenConversation, OPEN_CONVERSATION_EVENT, type OpenConversationDetail } from '../../../utils/palette-nav'

/**
 * 运行中排队的一条消息（V4-Iter-238）。
 * 只在渲染层内存里，**不落库、不进 store**：刷新页面就没了。这是有意的——
 * 排队项既不是消息也不是任务，把它持久化就得引入第三种存储形状，而它的全部价值在"这一轮跑完接着说"。
 * 类型与结算规则已抽到 `../queue-settlement`（P2 / V4-Iter-459），这里只做兼容导出。
 */
export type { AgentQueueItem } from '../queue-settlement'

/** 排队条上限与实现都在对话壳共用的 `useAgentQueue`，这里只做兼容导出 */
export { MAX_QUEUE_ITEMS }

export function useAgentChat(providers: ProviderRecord[], assistants?: AssistantRecord[]) {
  const { t } = useI18n()
  const toast = useToast()
  const [assistantId, setAssistantId] = useState('')
  const [conversations, setConversations] = useState<import('../../../../../shared/types').ConversationRecord[]>([])
  const [archivedConversations, setArchivedConversations] = useState<import('../../../../../shared/types').ConversationRecord[]>([])
  // §259：这两发列表读失败时屏上摆的是**上一份列表**（切换助手那发是空列表＋「还没有会话」）——
  // 而失败对象 `{ok:false,error}` 一旦被当数组写进来，`SessionRail` 的 `.map` 与 `AgentPanel:148` 的 `.find` 当场 TypeError。
  // 状态按 §256 那档写法留 `{error}`、在渲染时才拼句子，这样这两个 effect 的依赖里不用加 `t`
  // （加了 `t`，换语言会让助手 effect 重跑一次，并把选中会话跳回「最近一条」——那是另一条回归）。
  // 两句分开：活跃与归档是两发读，各自的失败各自点名（§257 的逐发点名口径）。
  const [conversationsUnread, setConversationsUnread] = useState<{ error?: string } | null>(null)
  const [archivedUnread, setArchivedUnread] = useState<{ error?: string } | null>(null)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, dispatch] = useReducer(messagesReducer, [] as AgentMessage[])
  const [running, setRunning] = useState(false)
  const [interrupted, setInterrupted] = useState(false) // 上次运行被中止/出错（可断点恢复）
  const [runStats, setRunStats] = useState<AgentRunStats | null>(null) // 当前会话最近一次运行统计（trace 持久化，切回/刷新后恢复）
  const [sessionStats, setSessionStats] = useState<AgentSessionStats | null>(null) // 当前会话累计统计（跨全部运行）
  // §264 第五面：这两发读过去失败侧只有一句 `return`——不摆假数字（复位后整块不出现／落到「分步明细」标题），
  // 但也没说"这次没读到"，于是那一轮看着像"没有统计这回事"。原因各挂自己那一发（§259 逐发点名）。
  const [runStatsUnread, setRunStatsUnread] = useState<{ error?: string } | null>(null)
  const [sessionStatsUnread, setSessionStatsUnread] = useState<{ error?: string } | null>(null)
  // §265 第六面：按「停止」时这一发的结果过去整个丢，而下一句就把界面改成"已停"——
  // `safeHandle` 下主进程的失败是**已 resolve 的 `{ok:false}`**，连 `.catch` 都不经过。
  const [stopUnread, setStopUnread] = useState<{ error?: string; requestId?: string } | null>(null)
  const [latestTraces, setLatestTraces] = useState<AgentTraceRecord[] | null>(null) // 最近一次运行分步明细（null=未懒加载）
  const [tracesLoading, setTracesLoading] = useState(false)
  // §257：这一读失败时以前与「本次运行确实没有明细」长得一模一样（`agent.traceEmpty`），
  // 屏上那句「暂无分步明细」就在替一次失败说话。分三态：加载中／读不到／确实没有。
  const [latestTracesUnread, setLatestTracesUnread] = useState<string | null>(null)
  /**
   * §235：当前这条会话的身份读数。三种状态各有脸：
   *  · `loading` —— 还没读到（新路径才走这一档：命令面板/恢复）⇒ 与今天一样能发；
   *  · `ok` 且 record 带父 ⇒ 这是**子代理会话**，只读；
   *  · `failed` —— 读不到身份 ⇒ 也按只读处理，并说清楚为什么。宁可输入框暂时消失，
   *    也不让人把消息发进一条机器会话：那种 run 的步骤不进父的 token 汇总（§163 口径），
   *    发出去的钱与产物都看不见。
   */
  const [subSessionIdentity, setSubSessionIdentity] = useState<SubSessionIdentity>({ state: 'loading' })
  /** 当前会话的直接子会话（「子代理会话」那格列表；读失败时保持空，另有一句 unread 的话） */
  const [subSessions, setSubSessions] = useState<ConversationRecord[]>([])
  const [subSessionsUnread, setSubSessionsUnread] = useState<string | null>(null)
  const [currentStep, setCurrentStep] = useState(0) // 当前运行正在执行的步数（running 时显示，结束后丢弃）
  /** 零调用提示：本次运行有工具可用但模型未调用任何工具时显示（实现见 `useZeroToolCallNotice`） */
  const {
    visible: noToolCallNotice,
    mcpHeldBack,
    setVisible: setNoToolCallNotice,
    applyDone: applyZeroToolCallNotice,
    clear: clearZeroToolCallNotice
  } = useZeroToolCallNotice()
  /**
   * §237：这一轮的固定开销已超过**声明过的**窗口，历史只带了最近一问（引擎那侧 `windowPlan.noRoom`）。
   * 只在 DONE 带 true 时点亮，切会话／起新一轮都清掉——它是"这一轮"的事实，不是会话的属性。
   */
  const [historyTight, setHistoryTight] = useState(false)
  /** 运行中实时步骤条 chip 流（done/error/切会话清空；不打 messages-reducer，避免污染消息流） */
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  /**
   * 模型级配置（上下文窗口 / 备用链 / 文本协议）：P4 批次 0 起状态与读写全部收进
   * `useAgentModelExtras`——对话壳也调用同一份实现，这里只解构出既有对外字段。
   */
  const {
    textProtocolForced,
    textProtocolUnread,
    retryTextProtocol,
    setTextProtocol,
    contextWindowTokens,
    contextWindowUnread,
    setContextWindow,
    fallbackTarget,
    fallbackMissing,
    fallbackUnread,
    setFallback
  } = useAgentModelExtras(providerId, model, providers)
  const requestIdRef = useRef('')
  // 事件订阅闭包内读取当前会话（effect 仅依赖 [t]，不能直接用 conversationId state）
  const conversationIdRef = useRef<string | null>(null)
  conversationIdRef.current = conversationId
  /**
   * §398：「本次运行统计」这一整块（统计那格＋展开的分步明细）**现在讲的是哪一次运行**。
   *  · `null` —— 还没有本轮事实＝进入/切回会话时那发「这个会话最近一次跑成什么样」（挂载路径的本义）；
   *  · 有值 —— 刚跑完的这一轮（DONE 事件带来的 requestId）。
   * 只留一个身份、两处共用：统计的兜底重读、那颗「重试」、展开明细的取数都问同一个问题。
   * 少了这一颗，"本轮一行 trace 都没落库"那一档（`safeTrace` 写失败只 warn）就会顺着 `created_at DESC`
   * 退到**上一轮**，把别人的账挂在「本次运行」下＝说假话；只改统计不改明细还会留一张自相矛盾的屏
   * （标题「0 步」，下面列出上一轮的步骤）。
   */
  const runBlockRef = useRef<{ conversationId: string; requestId: string } | null>(null)

  /**
   * 运行中排队 / 插队（V4-Iter-238）：实现已抽到对话壳共用的 `useAgentQueue`（P4 批次 0），
   * 这里不再保留第二份；`runningRef` 仍是本 hook 的「此刻是否在跑」，`sendRef`/`canStartRunRef`
   * 让结算回调读得到当前渲染的模型/会话。
   */
  const runningRef = useRef(false)
  const sendRef = useRef<(text: string, attachments: ChatAttachment[]) => void>(() => {})
  const canStartRunRef = useRef<() => boolean>(() => false)

  /** running 的唯一写入口：ref 与 state 同步走，回调里读 runningRef 才拿得到"此刻" */
  const setRunningNow = (v: boolean): void => {
    runningRef.current = v
    setRunning(v)
  }

  const {
    queue,
    enqueueText,
    interjectText,
    dropQueued,
    sendQueuedNow,
    ackInterject,
    settleAfterRun: settleQueueAfterRun
  } = useAgentQueue({
    getConversationId: () => conversationIdRef.current,
    getRequestId: () => requestIdRef.current || null,
    isRunning: () => runningRef.current,
    canStartRun: () => canStartRunRef.current(),
    send: (text, attachments) => sendRef.current(text, attachments)
  })

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

  // §258：这两发是**写**（把「当前选中的助手／会话」存回 ui_prefs），失败过去只进 console。
  // 后果不当场可见：下次启动不会回到这里。口径＝不弹 toast（会撞在启动那一下），
  // 但在面板挂一行常驻的「没能记住」，写成功就收回。
  const [uiPrefsUnread, setUiPrefsUnread] = useState<string | null>(null)

  useEffect(() => {
    if (!restored) return
    // 加载中间态（还没定下助手/会话）不写，否则会把上次的存档清掉
    if (!assistantId || !conversationId) return
    void window.pocketai
      .setUiPrefs({ agentAssistantId: assistantId, agentConversationId: conversationId })
      .then((r) => {
        // 该通道成功也返回 {ok:true,data} 信封，不能用 isIpcFail 判别
        if (r.ok === false) {
          logIpcError('agent.setUiPrefs', r.error ?? 'failed')
          setUiPrefsUnread(ipcFailText(r, t('common.unknownError')))
          return
        }
        setUiPrefsUnread(null)
      })
      .catch((e: unknown) => {
        logIpcError('agent.setUiPrefs', e)
        setUiPrefsUnread(errText(e, t('common.unknownError')))
      })
  }, [restored, assistantId, conversationId, t])

  // 恢复来的助手必须仍然存在（助手可能被删除或被导入覆盖）；不在「我的助手」列表里不等于不存在——
  // 停用的内置助手仍被旧会话引用，所以按 id 查一次再决定是否清回自由会话
  useEffect(() => {
    if (!restored || !assistants) return
    if (!assistantId) return
    if (assistants.some((a) => a.id === assistantId)) return
    let cancelled = false
    void window.pocketai
      .getAssistant(assistantId)
      .then((a) => {
        if (cancelled) return
        // 读不到就不做判断：宁可保留旧存档，也不能因为一次读失败把会话清成自由会话
        if (hasIpcFailed(a)) {
          logIpcError('agent.getAssistant', a.error ?? 'failed')
          return
        }
        if (a) return // 存在（可能是已停用的内置助手）⇒ 保留
        setAssistantId('')
        setConversationId(null)
        restoreRef.current = null
        void window.pocketai
          .setUiPrefs({ agentAssistantId: '', agentConversationId: '' })
          .then((r) => {
            if (r.ok === false) {
              logIpcError('agent.setUiPrefs', r.error ?? 'failed')
              setUiPrefsUnread(ipcFailText(r, t('common.unknownError')))
              return
            }
            setUiPrefsUnread(null)
          })
          .catch((e: unknown) => {
            logIpcError('agent.setUiPrefs', e)
            setUiPrefsUnread(errText(e, t('common.unknownError')))
          })
      })
      .catch((e: unknown) => {
        logIpcError('agent.getAssistant', e)
      })
    return () => {
      cancelled = true
    }
  }, [restored, assistants, assistantId, t])

  // 助手切换 → 拉活跃+归档会话列表并自动选中最近一次（活跃列表已按置顶权重+updated_at DESC 排序）
  useEffect(() => {
    if (!assistantId) {
      // 没有助手＝没有列表可读，那两句"读不到"也不该留在屏上
      setConversationsUnread(null)
      setArchivedUnread(null)
      return
    }
    let cancelled = false
    void Promise.all([
      window.pocketai.listConversations(assistantId, true, false),
      window.pocketai.listConversations(assistantId, true, true)
    ]).then(([list, archived]) => {
      if (cancelled) return
      // §259：这两发各判各的、各说各的（§257 的逐发点名口径）——活跃读到而归档没读到，
      // 不该把读到的那份也一起扔了，更不该让失败对象进 state（下面每一句 `list.find` 与
      // `SessionRail` 的 `.map`、`AgentPanel:148` 的 `.find` 都会当场 TypeError，探针实测：整屏一个字都不剩）。
      // 切换助手这一发**必须清空各自那一份**：上一份列表属于别的助手，留着比清空更会骗人。
      if (hasIpcFailed(list) || !Array.isArray(list)) {
        setConversations([])
        setConversationsUnread({ error: hasIpcFailed(list) ? list.error : undefined })
      } else {
        setConversationsUnread(null)
        setConversations(list)
      }
      if (hasIpcFailed(archived) || !Array.isArray(archived)) {
        setArchivedConversations([])
        setArchivedUnread({ error: hasIpcFailed(archived) ? archived.error : undefined })
      } else {
        setArchivedUnread(null)
        setArchivedConversations(archived)
      }
      // 选会话要在两份数组上找：活跃那半没读到就到此为止；只挂归档那半时**照常选**
      // （findConv 只是给"命令面板指定 id／恢复上次"补 modelLabel，拿不到就当未设过——
      //  为它取消用户已选中的会话，比少一条标签更伤）
      if (!Array.isArray(list)) {
        setConversationId(null)
        return
      }
      const archivedArr = Array.isArray(archived) ? archived : []
      // 待恢复的会话必须属于这个助手，否则视为失效（被删/跨助手残留）
      const want =
        restoreRef.current && restoreRef.current.assistantId === assistantId
          ? restoreRef.current.conversationId
          : ''
      const restoredHit = want ? list.find((x) => x.id === want) : undefined
      restoreRef.current = null
      // 命令面板在 P1 起一律走对话模块；Agent 壳批次 1 起已无入口，这里只保留壳内自洽的兜底消费
      const pending = consumePendingOpenConversation({ assistantId })
      const findConv = (id: string) => list.find((x) => x.id === id) ?? archivedArr.find((x) => x.id === id)
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
    }).catch((e: unknown) => {
      // reject 面走同一张脸：两份都清空＋那两句挂上
      if (cancelled) return
      setConversations([])
      setArchivedConversations([])
      setConversationId(null)
      setConversationsUnread({ error: errText(e, '') })
      setArchivedUnread({ error: errText(e, '') })
      logIpcError('agent.listConversations', e)
    })
    return () => { cancelled = true }
  }, [assistantId])

  // 命令面板导航（同助手直接开会话；跨助手交助手切换 effect 消费 pending）
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<OpenConversationDetail>).detail
      if (!d || !d.toolsEnabled) return
      if (d.assistantId && d.assistantId !== assistantId) {
        setAssistantId(d.assistantId) // 助手 effect 重新拉列表时消费 pending
        return
      }
      consumePendingOpenConversation({ assistantId }) // 同助手：清掉遗留 pending 防残留
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
  const subSession = subSessionOf(subSessionIdentity)
  /** 身份读不到的那句话（界面据此显示只读条＋重试，而不是假装这条会话能发） */
  const identityUnread = identityUnreadOf(subSessionIdentity)
  /**
   * 只读判据（一处派生，六处接管：输入区整块、卡片上的删除／截断重跑／重新生成／右键提醒、断点恢复那条）。
   * `loading` 不在内：那一档只出现在"没有任何本地线索"的入口，且和用户敲下回车之间是几毫秒，
   * 把它算进去会让每次切会话都闪一次输入框。
   */
  const subSessionReadonly = isSubSessionReadonly(subSessionIdentity)

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

  /**
   * §264 第五面：这两发读收口成"判了也说话"。两条守卫按 §260 那条纪律走**先判归属再判失败**——
   * 迟到那发的失败不许在已切过去的会话屏上留一句"读不到"（成功支本来就是这么挡的，失败支过去根本没挡）。
   * 每次重新拉取先收回上一句（§256 陈旧谎报），读到即清，reject 面与 resolve 的失败对象同一张脸。
   */
  const loadRunStats = useCallback((id: string) => {
    setRunStatsUnread(null)
    // §398：这一发问的是"这个会话最近一次"⇒这一块现在讲的是"没有哪一轮是当场跑出来的"
    runBlockRef.current = null
    void window.pocketai.getLatestRunStats(id).then((stats) => {
      if (conversationIdRef.current !== id) return
      if (hasIpcFailed(stats)) {
        setRunStatsUnread({ error: stats.error })
        return
      }
      setRunStats(stats)
    }).catch((e: unknown) => {
      if (conversationIdRef.current !== id) return
      setRunStatsUnread({ error: errText(e, '') })
      logIpcError('agent.getLatestRunStats', e)
    })
  }, [])

  /**
   * §398：这一发问的是"**这一轮**跑成什么样"（按 requestId，走 `agent:get-run-stats`）。
   * 上一发不能替它答：本轮一行 trace 都没落库时（`safeTrace` 写失败只 warn），
   * `latestStatsByConversation` 会顺着 `created_at DESC` 取到**上一轮**那个 request，
   * 回一份非零数字，而渲染层把它画在「本次运行统计」下＝说假话。
   * 两道守卫各挡一面：切走了别画（会话），新一轮已经开跑别把上一轮的数当新的（运行）。
   */
  const loadRunStatsForRun = useCallback((runConversationId: string, requestId: string) => {
    setRunStatsUnread(null)
    void window.pocketai.getRunStats(requestId).then((stats) => {
      if (conversationIdRef.current !== runConversationId) return
      if (requestIdRef.current !== requestId) return
      if (hasIpcFailed(stats)) {
        setRunStatsUnread({ error: stats.error })
        return
      }
      setRunStats(stats)
    }).catch((e: unknown) => {
      if (conversationIdRef.current !== runConversationId) return
      if (requestIdRef.current !== requestId) return
      setRunStatsUnread({ error: errText(e, '') })
      logIpcError('agent.getRunStats', e)
    })
  }, [])

  /** 那颗「重试」＝把**这一块现在讲的那一次运行**再问一遍，不是永远问"会话最近一次" */
  const retryRunStats = useCallback(() => {
    const convId = conversationIdRef.current
    if (!convId) return
    const run = runBlockRef.current
    if (run) {
      loadRunStatsForRun(run.conversationId, run.requestId)
      return
    }
    loadRunStats(convId)
  }, [loadRunStats, loadRunStatsForRun])

  /** 会话累计统计（跨全部运行）——同上一条的形状，独立一句，一发挂掉不许把另一发说成不可信 */
  const loadSessionStats = useCallback((id: string) => {
    setSessionStatsUnread(null)
    void window.pocketai.getSessionStats(id).then((stats) => {
      if (conversationIdRef.current !== id) return
      if (hasIpcFailed(stats)) {
        setSessionStatsUnread({ error: stats.error })
        return
      }
      setSessionStats(stats)
    }).catch((e: unknown) => {
      if (conversationIdRef.current !== id) return
      setSessionStatsUnread({ error: errText(e, '') })
      logIpcError('agent.getSessionStats', e)
    })
  }, [])

  useEffect(() => {
    setInterrupted(false)
    setRunStats(null)
    setSessionStats(null)
    setRunStatsUnread(null)
    setSessionStatsUnread(null)
    setLatestTraces(null)
    setLatestTracesUnread(null)
    setTracesLoading(false)
    setLiveSteps([])
    clearZeroToolCallNotice()
    // §237：那句"这一轮带不下更多历史"是**那一轮**的事实，切会话不该把它带过去
    setHistoryTight(false)
    if (!conversationId) {
      dispatch({ type: 'clear' })
      return
    }
    void window.pocketai.listMessages(conversationId).then((dbMsgs: MessageRecord[]) => {
      // §309：迟到响应不许画进别的会话——切到 B 之后 A 的那一发才回来，会把 A 的卡片
      // 直接 dispatch 成当前屏（而卡片是会话级 state：切走再切回就"凭空多出/丢失消息"）。
      // 判据与本文件其余四发一致（loadRunStats:775/782、loadSessionStats:792/799、loadSubSessionReads:682）：
      // 「这一发是不是还给当前会话」。conversationIdRef 在 render 期同步（:127），不会误挡首次加载。
      if (conversationIdRef.current !== conversationId) return
      if (hasIpcFailed(dbMsgs)) return
      dispatch({ type: 'load', messages: toAgentMessages(dbMsgs) })
    }).catch(reportIpcError('agent.listMessages'))
    // 恢复该会话最近一次运行统计（trace 持久化，刷新/切回仍可见）＋加载会话累计统计（跨全部运行聚合）
    // ——§264：两发各自一条路（`loadRunStats`／`loadSessionStats`），界面侧各挂一句、各给一次重试
    loadRunStats(conversationId)
    loadSessionStats(conversationId)
  }, [conversationId, loadRunStats, loadSessionStats])

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
          // 按 clientRef 过滤即幂等：重复事件结果不变（见 `../queue-settlement`）
          ackInterject(e.clientRef)
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
        settleQueueAfterRun(e.conversationId, e.requestId, e.conversationId === conversationIdRef.current)
        // 仅在事件仍归属当前会话时展示统计与复位（切会话后迟到的 DONE 不覆盖）
        if (e.conversationId === conversationIdRef.current) {
          setInterrupted(false)
          // §398：从这一秒起，「本次运行统计」这一块讲的就是**这一轮**——兜底重读、那颗「重试」
          //        与展开的分步明细都顺着这一颗身份问，不再顺着会话退到上一轮
          runBlockRef.current = { conversationId: e.conversationId, requestId: e.requestId }
          // §396：主进程那一发 trace 统计读不出来时**不带这颗**（改前回一份 `{0,0,0}` ⇒ 屏上
          //        「0 步 · 耗时 0ms · 0 tokens」与"这轮确实一步没跑成"是同一个形状）。
          //        缺席⇒先复位再走与挂载同一条重读路：读到就填真值，读不到就亮那颗既有的
          //        「本次运行统计 读不到」＋重试键（§264 那张脸，本枚复用不另起一句）。
          if (e.traceStats) {
            setRunStats(e.traceStats)
            setRunStatsUnread(null)
          } else {
            setRunStats(null)
            // §398：这一发改按**这一轮**取（原先走 `loadRunStats(e.conversationId)`＝会话最近一次，
            //        本轮零行时会把上一轮的非零账挂在「本次运行统计」下）。
            loadRunStatsForRun(e.conversationId, e.requestId)
          }
          // 零调用提示：本轮有工具可用却一次都没调用**且整条会话都没有过工具卡**才亮
          //（判定与展示在 P4 批次 0 起与对话壳共用同一份实现，见 `useZeroToolCallNotice`）
          applyZeroToolCallNotice(
            e.usedTools,
            e.mcpHeldBack,
            messagesRef.current.some((m) => m.role === 'tool')
          )
          // §237：引擎那一侧算出来的"这一轮带不下更多历史"上屏（只在 true 时点亮）
          setHistoryTight(e.historyTight === true)
          // §245：子会话是**这一轮跑出来的**，而 `subSessions` 原来只在进入会话时读一次 ⇒
          // 委派跑完当场两处入口都不出现，要切走再回来才看见（2026-10-21 真机 B133 撞出来的）。
          // 只在"这一轮就是当前看着的这条会话"时重读：别的会话的 DONE 不该动这里的列表。
          loadSubSessionReads()
          // 把知识库引用来源与「有没有检索/命中几条」挂到最终回答卡片（流式结束即时显示，无需 reload）
          if (e.sources?.length || e.retrieval) {
            dispatch({
              type: 'setSources',
              messageId: e.finalMessageId,
              sources: e.sources,
              retrieval: e.retrieval
            })
          }
          // 运行结束后刷新会话累计统计（本次运行已入库）
          // 运行结束后刷新会话累计统计（本次运行已入库）——§264：走与挂载同一条路，失败同样上屏＋可重试
          loadSessionStats(e.conversationId)
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
        settleQueueAfterRun(e.conversationId, e.requestId, false)
        // 「可断点恢复」是按会话讲的：正在看别的会话时不该被上一轮的失败点亮
        if (e.conversationId === conversationIdRef.current) {
          setInterrupted(true)
          // §245 同一件事的失败面：委派跑了一半才炸，已经建出来的子会话当场就该看得见
          loadSubSessionReads()
        }
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
    // §245：`loadSubSessionReads` 本身只随 `t` 变（useCallback([t])），加进来不改变重订阅的时机——
    // 但少了它，切语言后这里闭包到的还是旧那份取词函数，"读不到子代理会话"那句会停在旧语言
  }, [t, loadSubSessionReads])

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
      // §259：这一发是"刷新"（置顶／归档／导入之后），与切换助手那一发不同——**上一份是同一个助手的列表**，
      // 清空反而会把"刚归档完这一条"变成"整列消失"。所以：失败的那半保持上一份＋点名说读不到（§222 的口径），
      // 成功的那半照常写。两半都必须判——失败对象 `{ok:false,error}` 是 truthy，写进去之后
      // `SessionRail` 的 `.map` 与 `AgentPanel:148` 的 `.find` 当场 TypeError（探针实测）。
      if (hasIpcFailed(list) || !Array.isArray(list)) {
        setConversationsUnread({ error: hasIpcFailed(list) ? list.error : undefined })
      } else {
        setConversationsUnread(null)
        setConversations(list)
      }
      if (hasIpcFailed(archived) || !Array.isArray(archived)) {
        setArchivedUnread({ error: hasIpcFailed(archived) ? archived.error : undefined })
      } else {
        setArchivedUnread(null)
        setArchivedConversations(archived)
      }
    } catch (e) {
      setConversationsUnread({ error: errText(e, '') })
      setArchivedUnread({ error: errText(e, '') })
      logIpcError('agent.reloadConversations', e)
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
    setLatestTracesUnread(null)
    // §398：这一格讲的是哪一次运行，明细就按那一次取。本轮零行时顺着会话取会列出**上一轮**的步骤，
    //        而头顶那行已经是这一轮的「0 步」＝一句真话配一份假明细。null＝挂载那发讲的"最近一次"。
    const run = runBlockRef.current
    const asked = run?.requestId ?? null
    const call: Promise<AgentTraceRecord[] | { ok: false; error: string }> =
      run ? window.pocketai.getRunTraces(run.requestId) : window.pocketai.getLatestRunTraces(convId)
    void call.then((traces) => {
      // §221：失败只跳过"写数据"这一半，setTracesLoading(false) 照跑（与下面那个 .catch 同形）；
      // 整条早退会把统计条永久卡在加载态
      if (conversationIdRef.current === convId) {
        if (asked && requestIdRef.current !== asked) {
          // 新一轮已经开跑：上一轮的明细不许画进这一轮（`send()` 把 latestTraces 清成 null 等这一发）
          setTracesLoading(false)
          return
        }
        if (hasIpcFailed(traces)) {
          setLatestTracesUnread(ipcFailText(traces, t('agent.unknownError')))
        } else {
          setLatestTraces(traces)
        }
        setTracesLoading(false)
      }
    }).catch((e: unknown) => {
      logIpcError(asked ? 'agent.getRunTraces' : 'agent.getLatestRunTraces', e)
      if (conversationIdRef.current === convId) {
        setLatestTracesUnread(errText(e, t('agent.unknownError')))
        setTracesLoading(false)
      }
    })
  }, [t])

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
    setLatestTracesUnread(null) // 上一轮那次"取不到"也不作数：这一轮还没读过
    setHistoryTight(false) // 上一轮那句"带不下更多历史"不作数：这一轮的窗口判据还没算出来
    setStopUnread(null) // §265：上一发"停止没送到"不作数——这一轮还没按过停止（陈旧谎报要自己退场，§256）
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

  /** 送一次停止并判结果：`{ok:false}` 与 reject **同一张脸**，都写进 `stopUnread`（连 requestId 一起记住，才谈得上再送一次） */
  const sendAbort = (id: string): void => {
    window.pocketai
      .abortAgent(id)
      .then((r) => {
        if (hasIpcFailed(r)) {
          setStopUnread({ error: r.error, requestId: id })
          return
        }
        setStopUnread(null)
      })
      .catch((e: unknown) => {
        setStopUnread({ error: errText(e, ''), requestId: id })
        logIpcError('agent.abortAgent', e)
      })
  }

  /**
   * §265 第六面：这一发过去是裸发（结果整块丢），下一句 `setRunningNow(false)` 却已经把界面改成"已停"——
   * 主进程收不到停止指令时，那一轮还在跑、token 还在烧，屏上却没有任何一句话。
   * 现在判它：送不到就说一句（**不阻断这条一点没动**——按钮照常立刻回到发送态，界面上另给一次"再送"的机会）。
   * `.catch` 挡的是通道级 reject（`safeHandle` 下的处理器失败走的是 resolve 那条）。
   */
  const abort = () => {
    if (requestIdRef.current) sendAbort(requestIdRef.current)
    setRunningNow(false)
  }

  /** 再送一次停止：界面已经回到未运行态，"停止"那颗键已经不在了，这句得有自己的出口 */
  const retryStop = (): void => {
    if (stopUnread?.requestId) sendAbort(stopUnread.requestId)
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
    conversationsUnread,
    archivedUnread,
    conversationId,
    messages,
    running,
    interrupted,
    runStats,
    runStatsUnread,
    stopUnread,
    retryStop,
    sessionStats,
    sessionStatsUnread,
    loadRunStats,
    retryRunStats,
    loadSessionStats,
    latestTraces,
    latestTracesUnread,
    tracesLoading,
    loadLatestTraces,
    currentStep,
    liveSteps,
    noToolCallNotice,
    setNoToolCallNotice,
    mcpHeldBack,
    textProtocolForced,
    textProtocolUnread,
    retryTextProtocol,
    uiPrefsUnread,
    setTextProtocol,
    contextWindowTokens,
    contextWindowUnread,
    setContextWindow,
    fallbackTarget,
    fallbackMissing,
    fallbackUnread,
    setFallback,
    historyTight,
    dismissHistoryTight: () => setHistoryTight(false),
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
