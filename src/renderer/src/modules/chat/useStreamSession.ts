import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatTarget } from '../../../../shared/types'
import type { CompareColumn } from './ComparisonColumns'
import type { FocusBranch } from './ChatView'
import type { AgentMessage, LiveStep } from '../agent/agent-shared'
import { reduceLiveSteps } from '../agent/agent-shared'
import { messagesReducer } from '../agent/hooks/messages-reducer'
import { hasIpcFailed, logIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'

/**
 * 流式会话 hook：收口 ChatModule 中散落的 6 个流式 ref（requestId/finalized/
 * totalColumns/settledCount/focusNonce/streamingConv）与相关状态（liveColumns、
 * focusBranch）及事件订阅逻辑。
 *
 * 暴露的原子操作：
 * - beginStream  发起流式：初始化 ref + liveColumns，返回 requestId（忙时返回 null）
 * - failStream   IPC reject 兜底：清 ref + 清 liveColumns + 按需重载消息
 * - focusNewBranch  regenerate/resend 用：发分支聚焦信号（nonce 自增）
 * - abort        中止当前流式
 * - isStreaming  是否流式中（ref 直读，handler 内可安全调用）
 *
 * init 期数据加载（providers/assistants）仍由 ChatModule 自行处理，本 hook 只管流式。
 */
export interface UseStreamSessionOptions {
  /** finalize 后按需重载消息（仅当当前会话仍为流式会话时） */
  loadMessages: (convId: string) => void | Promise<void>
  /** finalize 后刷新会话列表 */
  reloadConversations: () => void
  /** 读取当前会话 id（finalize 时判断是否仍需 loadMessages） */
  getCurrentConvId: () => string | null
  /**
   * 全部目标列落定后的成败汇总（在 finalize 时同步触发一次）：
   * 至少一列 done → 'done'；全部 error/aborted → 'error'。供失焦通知等使用。
   * P2 起带上 `requestId`：对话页用它把「刚跑完的那一轮」映射到轮次摘要上，done 之后聚焦该轮摘要；
   * 聊天流没有 requestId 时为 null。
   */
  onStreamsSettled?: (convId: string, outcome: 'done' | 'error', requestId?: string | null) => void
  /**
   * P4 批次 0：引擎已收下一条运行中插队（`interject` 步事件带同一个 clientRef）。
   * 队列对账复用这一份事件订阅，不在宿主里另起一套事件解析。
   */
  onAgentInterject?: (clientRef: string, requestId: string) => void
  /**
   * P4 批次 0：Agent DONE 的附加事实（`usedTools` / `mcpHeldBack`）。
   * 零调用提示要按「本轮有没有用工具」决定亮灭；订阅仍复用这一份事件流，不另起监听。
   */
  onAgentDoneMeta?: (meta: {
    conversationId: string
    usedTools?: boolean
    mcpHeldBack?: number
  }) => void
  /** Agent 步骤 error 事件缺 error 文案时的兜底句（随界面语言） */
  unknownErrorText?: string
}

/** 单列落定状态（与 CompareColumn['status'] 对齐，含 abort 中断） */
export type SettledStatus = 'done' | 'error' | 'aborted'

/**
 * 汇总各列落定状态：至少一列 done 即整体成功；空数组或全非 done 为失败。
 * 纯函数，供单测。
 */
export function settledOutcome(statuses: readonly SettledStatus[]): 'done' | 'error' {
  return statuses.some((s) => s === 'done') ? 'done' : 'error'
}

export interface UseStreamSessionApi {
  /** 流式中的虚拟列（非 null 表示正在流式） */
  liveColumns: CompareColumn[] | null
  /** Agent 模式下正在跑的事件流（按 requestId 归属；非 null 表示这一轮来自 Agent） */
  agentStream: { convId: string; requestId: string; messages: AgentMessage[] } | null
  /** Agent 模式是否在跑（会话切换后仍为 true，用于全局忙碌态） */
  agentRunning: boolean
  /** P2：运行中实时步骤条（与 Agent 调试台同一份 `reduceLiveSteps` 归约结果）；非运行态为空数组 */
  liveSteps: LiveStep[]
  /** 分支聚焦信号：regenerate/resend 后把对应轮次切到新分支 */
  focusBranch: FocusBranch | null
  /** 是否流式中（ref 直读，事件 handler 内调用即得最新值） */
  isStreaming: () => boolean
  /** 当前运行的 requestId（ref 直读）；null = 没有运行。运行中插队需要它做归属 */
  getRequestId: () => string | null
  /** 发起流式：初始化 6 ref + liveColumns，返回 requestId；忙时返回 null */
  beginStream: (convId: string, targets: ChatTarget[]) => string | null
  /** 发起 Agent 模式事件流：不建虚拟列，改由 agentStream 收 step/chunk，返回 requestId；忙时返回 null */
  beginAgentStream: (convId: string) => string | null
  /** 流式 IPC reject 兜底：清 ref + 清 liveColumns/agentStream + 按需 loadMessages */
  failStream: (requestId: string, convId: string) => void
  /** 发分支聚焦信号（nonce 自增，ChatView effect 据此回填新分支） */
  focusNewBranch: (turnKey: string, batchId: string) => void
  /** 中止当前流式 */
  abort: () => void
  /** §266：停止指令没送到主进程时的原因（界面挂一句；流式落定或新一轮开始即收回） */
  stopUnread: { error?: string } | null
}

export function useStreamSession(opts: UseStreamSessionOptions): UseStreamSessionApi {
  const [liveColumns, setLiveColumns] = useState<CompareColumn[] | null>(null)
  const [agentStream, setAgentStream] = useState<{
    convId: string
    requestId: string
    messages: AgentMessage[]
  } | null>(null)
  const [agentRunning, setAgentRunning] = useState(false)
  /** P2：实时步骤条数据；订阅 step 事件、用 `reduceLiveSteps` 归约 */
  const [liveSteps, setLiveSteps] = useState<LiveStep[]>([])
  const [focusBranch, setFocusBranch] = useState<FocusBranch | null>(null)
  /** §266 第六面：按「停止」那一发的结果过去只交给 `.catch(reportIpcError(...))`——
   *  而 abort 走 safeHandle，失败是**已 resolve 的 `{ok:false}`**，那条 catch 不会经过 ⇒ 屏上零字，流却还在跑。 */
  const [stopUnread, setStopUnread] = useState<{ error?: string } | null>(null)

  const requestIdRef = useRef<string | null>(null)
  const finalizedRef = useRef(false)
  const totalColumnsRef = useRef(0)
  const settledCountRef = useRef(0)
  const focusNonceRef = useRef(0)
  const streamingConvRef = useRef<string | null>(null)
  // 各列落定状态（finalize 时汇总成败供 onStreamsSettled）
  const resultsRef = useRef<SettledStatus[]>([])

  // opts 存 ref，避免事件订阅 effect 因回调重建而反复重订阅（流式期间重订阅可能丢 chunk）
  const optsRef = useRef(opts)
  optsRef.current = opts

  // 订阅流式事件；订阅一次即可，回调内通过 optsRef 读最新的 loadMessages 等
  useEffect(() => {
    const offChunk = window.pocketai.onChatChunk((e) => {
      if (e.requestId !== requestIdRef.current) return
      setLiveColumns((prev) => {
        if (!prev) return prev
        return prev.map((c, i) =>
          i === e.targetIndex ? { ...c, content: c.content + e.delta } : c
        )
      })
    })

    const markSettled = (_requestId: string, index: number, patch: Partial<CompareColumn>) => {
      setLiveColumns((prev) =>
        prev ? prev.map((c, i) => (i === index ? { ...c, ...patch } : c)) : prev
      )
      if (patch.status === 'done' || patch.status === 'error' || patch.status === 'aborted') {
        resultsRef.current[index] = patch.status
      }
      settledCountRef.current += 1
      if (!finalizedRef.current && settledCountRef.current >= totalColumnsRef.current) {
        finalize()
      }
    }

    const offDone = window.pocketai.onChatDone((e) => {
      if (e.requestId === requestIdRef.current) markSettled(e.requestId, e.targetIndex, { status: 'done' })
    })
    const offError = window.pocketai.onChatError((e) => {
      if (e.requestId === requestIdRef.current) markSettled(e.requestId, e.targetIndex, { status: 'error', error: e.error })
    })

    // ---- Agent 模式事件流（v1：同一会话入口，只消费既有事件，不改引擎） ----
    // 归属只看 requestId：会话切走后仍继续归并，切回来还能看到这一轮的实时卡片。
    const offAgentStep = window.pocketai.onAgentStep((e) => {
      if (e.requestId !== requestIdRef.current) return
      // 插队对账放在这里：这句话是否已被引擎收下与用户当前看哪条会话无关（对话壳切走也照收）。
      if (e.type === 'interject' && e.clientRef) {
        optsRef.current.onAgentInterject?.(e.clientRef, e.requestId)
      }
      // 用户气泡由 ChatModule 本地乐观插入；interject 则要落成实时用户卡（同 Agent 壳口径），
      // 否则那句话只在队列条上消失、要等本轮结束重载后才看得见
      if (e.type === 'user') return
      setLiveSteps((prev) => reduceLiveSteps(prev, e))
      setAgentStream((prev) => {
        if (!prev || prev.requestId !== e.requestId) return prev
        return {
          ...prev,
          messages: messagesReducer(prev.messages, {
            type: 'step',
            event: e,
            unknownErrorText: optsRef.current.unknownErrorText ?? ''
          })
        }
      })
    })
    const offAgentChunk = window.pocketai.onAgentChunk((e) => {
      if (e.requestId !== requestIdRef.current) return
      setAgentStream((prev) => {
        if (!prev || prev.requestId !== e.requestId) return prev
        return {
          ...prev,
          messages: messagesReducer(prev.messages, {
            type: 'chunk',
            messageId: e.messageId,
            delta: e.delta,
            reasoning: e.reasoning
          })
        }
      })
    })
    let agentFinalizeTimer: ReturnType<typeof setTimeout> | null = null
    function finalizeAgent(convId: string, outcome: 'done' | 'error') {
      if (finalizedRef.current) return
      finalizedRef.current = true
      setStopUnread(null)
      const settledRequestId = requestIdRef.current
      optsRef.current.onStreamsSettled?.(convId, outcome, settledRequestId)
      const requestId = settledRequestId
      requestIdRef.current = null
      streamingConvRef.current = null
      // 与聊天流一样延迟 200ms：先让最后一段 chunk 画完，再重读库里的持久化消息并撤掉实时卡，
      // 避免 done 时立刻清空出现空白闪断。done 事件本身不再追加任何卡片（去重在 reducer/持久化）。
      agentFinalizeTimer = setTimeout(() => {
        agentFinalizeTimer = null
        optsRef.current.reloadConversations()
        const clearLive = () => {
          setAgentStream((prev) => (prev && prev.requestId === requestId ? null : prev))
          setAgentRunning(false)
          setLiveSteps([])
        }
        if (convId && optsRef.current.getCurrentConvId() === convId) {
          Promise.resolve(optsRef.current.loadMessages(convId)).finally(clearLive)
        } else {
          clearLive()
        }
      }, 200)
    }
    const offAgentDone = window.pocketai.onAgentDone((e) => {
      if (e.requestId !== requestIdRef.current) return
      optsRef.current.onAgentDoneMeta?.({
        conversationId: e.conversationId,
        usedTools: e.usedTools,
        mcpHeldBack: e.mcpHeldBack
      })
      finalizeAgent(e.conversationId, 'done')
    })
    const offAgentError = window.pocketai.onAgentError((e) => {
      if (e.requestId !== requestIdRef.current) return
      setAgentStream((prev) => {
        if (!prev || prev.requestId !== e.requestId) return prev
        // 引擎在发 error 前会先把当前占位 assistant 写入「（出错：…）／（已中止）」终态并作为 thought 步发出；
        // 这时别再追加第二张错误卡。只有连占位卡都没有的 setup 级失败才补一张，避免错误静默。
        const lastAssistant = [...prev.messages].reverse().find((m) => m.role === 'assistant')
        const alreadyNoticed =
          !!lastAssistant &&
          (lastAssistant.isError || /^（(出错：|已中止)/.test(lastAssistant.text))
        if (alreadyNoticed) return prev
        return {
          ...prev,
          messages: [
            ...prev.messages,
            {
              id: `agent-error-${e.requestId}`,
              role: 'assistant',
              text: `⚠️ ${e.error}`,
              isError: true
            }
          ]
        }
      })
      finalizeAgent(e.conversationId, 'error')
    })

    // finalize 在流式结束后延迟 200ms 再清空/重载，避免立即重渲染打断最后一段输出。
    // 这个 timer 必须在 effect cleanup 时清掉，否则组件卸载后会触发 setLiveColumns 等。
    let finalizeTimer: ReturnType<typeof setTimeout> | null = null
    function finalize() {
      if (finalizedRef.current) return
      finalizedRef.current = true
      setStopUnread(null) // §266：这一轮已经落定，那句"可能还在继续"到点了就作废（不留成新的谎）
      const convId = streamingConvRef.current
      // 成败汇总同步通知（失焦系统通知用）；缺记录按 error 保守处理
      if (convId) {
        optsRef.current.onStreamsSettled?.(convId, settledOutcome(resultsRef.current), requestIdRef.current)
      }
      requestIdRef.current = null
      streamingConvRef.current = null
      finalizeTimer = setTimeout(() => {
        finalizeTimer = null
        setLiveColumns(null)
        optsRef.current.reloadConversations()
        if (convId && optsRef.current.getCurrentConvId() === convId) optsRef.current.loadMessages(convId)
      }, 200)
    }

    return () => {
      offChunk()
      offDone()
      offError()
      offAgentStep()
      offAgentChunk()
      offAgentDone()
      offAgentError()
      if (finalizeTimer) clearTimeout(finalizeTimer)
      if (agentFinalizeTimer) clearTimeout(agentFinalizeTimer)
    }
  }, [])

  const isStreaming = useCallback(() => requestIdRef.current !== null, [])
  const getRequestId = useCallback(() => requestIdRef.current, [])

  const beginStream = useCallback((convId: string, targets: ChatTarget[]): string | null => {
    if (requestIdRef.current) return null // 正在流式中
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    setStopUnread(null) // §266：新一轮流式，上一发"停止没送到"不再作数（陈旧谎报要自己退场，§256）
    setAgentStream(null)
    setAgentRunning(false)
    finalizedRef.current = false
    totalColumnsRef.current = targets.length
    settledCountRef.current = 0
    resultsRef.current = new Array(targets.length)
    streamingConvRef.current = convId
    setLiveColumns(
      targets.map((t) => ({
        providerId: t.providerId,
        model: t.model,
        content: '',
        status: 'streaming' as const
      }))
    )
    return requestId
  }, [])

  /** Agent 模式：同一 requestId 认领，不建虚拟列；步骤由 agent 事件流归并成 AgentMessage 卡片 */
  const beginAgentStream = useCallback((convId: string): string | null => {
    if (requestIdRef.current) return null
    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    setStopUnread(null)
    finalizedRef.current = false
    totalColumnsRef.current = 0
    settledCountRef.current = 0
    resultsRef.current = []
    streamingConvRef.current = convId
    setLiveColumns(null)
    setAgentStream({ convId, requestId, messages: [] })
    setLiveSteps([])
    setAgentRunning(true)
    return requestId
  }, [])

  const failStream = useCallback((requestId: string, convId: string) => {
    if (requestIdRef.current !== requestId) return
    requestIdRef.current = null
    streamingConvRef.current = null
    setLiveColumns(null)
    setAgentStream((prev) => (prev && prev.requestId === requestId ? null : prev))
    setAgentRunning(false)
    setLiveSteps([])
    if (convId && optsRef.current.getCurrentConvId() === convId) optsRef.current.loadMessages(convId)
  }, [])

  const focusNewBranch = useCallback((turnKey: string, batchId: string) => {
    setFocusBranch({ turnKey, batchId, nonce: ++focusNonceRef.current })
  }, [])

  /**
   * §266 第六面：§224 那句注释早就写着「没停下来是要紧事（流还在跑、token 还在烧），得留痕」——
   * 但留痕只留进了 console：abort 走 safeHandle，失败是**已 resolve 的 `{ok:false}`**，那条 `.catch(reportIpcError)` 根本不经过。
   * 现在判它并说一句（不打断界面这条没动：流自己收尾，停止键也还在，再按一次就是重发）。
   */
  const abort = useCallback(() => {
    const id = requestIdRef.current
    if (!id) return
    window.pocketai
      .abortChat(id)
      .then((r) => {
        if (hasIpcFailed(r)) {
          setStopUnread({ error: r.error })
          return
        }
        setStopUnread(null)
      })
      .catch((e: unknown) => {
        setStopUnread({ error: errText(e, '') })
        logIpcError('chat.abortChat', e)
      })
  }, [])

  return {
    liveColumns,
    agentStream,
    agentRunning,
    liveSteps,
    focusBranch,
    isStreaming,
    getRequestId,
    beginStream,
    beginAgentStream,
    failStream,
    focusNewBranch,
    abort,
    stopUnread
  }
}
