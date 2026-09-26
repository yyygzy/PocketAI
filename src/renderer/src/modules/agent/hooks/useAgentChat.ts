// Agent 对话核心：助手/会话/消息流（reducer）/运行状态/Provider·模型选择/发送与中止
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AgentDoneEvent,
  AgentErrorEvent,
  AgentRunStats,
  AgentStepEvent,
  AgentTraceRecord,
  ChatAttachment,
  MessageRecord,
  ProviderRecord
} from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { reportIpcError } from '../../../utils/ipc'
import { toAgentMessages, type AgentMessage } from '../agent-shared'
import { messagesReducer } from './messages-reducer'

export function useAgentChat(providers: ProviderRecord[]) {
  const { t } = useI18n()
  const [assistantId, setAssistantId] = useState('')
  const [conversations, setConversations] = useState<import('../../../../../shared/types').ConversationRecord[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, dispatch] = useReducer(messagesReducer, [] as AgentMessage[])
  const [running, setRunning] = useState(false)
  const [interrupted, setInterrupted] = useState(false) // 上次运行被中止/出错（可断点恢复）
  const [runStats, setRunStats] = useState<AgentRunStats | null>(null) // 当前会话最近一次运行统计（trace 持久化，切回/刷新后恢复）
  const [latestTraces, setLatestTraces] = useState<AgentTraceRecord[] | null>(null) // 最近一次运行分步明细（null=未懒加载）
  const [tracesLoading, setTracesLoading] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const requestIdRef = useRef('')
  // 事件订阅闭包内读取当前会话（effect 仅依赖 [t]，不能直接用 conversationId state）
  const conversationIdRef = useRef<string | null>(null)
  conversationIdRef.current = conversationId

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId]
  )

  // 助手切换 → 拉会话列表并自动选中最近一次（列表已按 updated_at DESC 排序）
  useEffect(() => {
    if (!assistantId) return
    void window.pocketai.listConversations(assistantId, true).then((list) => {
      setConversations(list)
      setConversationId(list.length > 0 ? list[0]!.id : null)
    }).catch(reportIpcError('agent.listConversations'))
  }, [assistantId])

  // 会话切换 → 加载历史消息（同时复位中断标记、运行统计与分步明细）
  useEffect(() => {
    setInterrupted(false)
    setRunStats(null)
    setLatestTraces(null)
    setTracesLoading(false)
    if (!conversationId) {
      dispatch({ type: 'clear' })
      return
    }
    void window.pocketai.listMessages(conversationId).then((dbMsgs: MessageRecord[]) => {
      dispatch({ type: 'load', messages: toAgentMessages(dbMsgs) })
    }).catch(reportIpcError('agent.listMessages'))
    // 恢复该会话最近一次运行统计（trace 持久化，刷新/切回仍可见）；
    // 快速切会话时用 ref 丢弃迟到响应，避免旧会话统计覆盖当前会话
    void window.pocketai.getLatestRunStats(conversationId).then((stats) => {
      if (conversationIdRef.current === conversationId) setRunStats(stats)
    }).catch(reportIpcError('agent.getLatestRunStats'))
  }, [conversationId])

  // 订阅 Agent 流式事件（仅处理当前 requestId 的事件）
  useEffect(() => {
    const offs: Array<() => void> = []
    offs.push(
      window.pocketai.onAgentStep((e: AgentStepEvent) => {
        if (e.requestId !== requestIdRef.current) return
        dispatch({ type: 'step', event: e, unknownErrorText: t('agent.unknownError') })
      })
    )
    offs.push(
      window.pocketai.onAgentChunk((e: { messageId: string; delta: string; reasoning?: boolean }) => {
        dispatch({ type: 'chunk', messageId: e.messageId, delta: e.delta, reasoning: e.reasoning })
      })
    )
    offs.push(
      window.pocketai.onAgentDone((e: AgentDoneEvent) => {
        setRunning(false)
        setInterrupted(false)
        // 仅在事件仍归属当前会话时展示统计（切会话后迟到的 DONE 不覆盖）
        if (e.conversationId === conversationIdRef.current) {
          setRunStats(e.traceStats ?? null)
        }
      })
    )
    offs.push(
      window.pocketai.onAgentError((_e: AgentErrorEvent) => {
        setRunning(false)
        setInterrupted(true)
      })
    )
    return () => offs.forEach((off) => off())
  }, [t])

  const newConversation = async () => {
    if (!assistantId) return
    const c = await window.pocketai.createConversation(assistantId)
    setConversations((prev) => [c, ...prev])
    setConversationId(c.id)
  }

  // 删除历史会话（与对话页行为一致：无二次确认）
  const deleteConversation = async (id: string) => {
    await window.pocketai.deleteConversation(id)
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (conversationId === id) setConversationId(null)
  }

  // 重命名会话（本地同步更新，无需整表刷新）
  const renameConversation = async (id: string, title: string) => {
    await window.pocketai.renameConversation(id, title)
    setConversations((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c)))
  }

  // 重新拉取当前助手的会话列表（导入会话后用；不改变当前选中）
  const reloadConversations = useCallback(async () => {
    if (!assistantId) return
    try {
      const list = await window.pocketai.listConversations(assistantId, true)
      setConversations(list)
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
      await window.pocketai.deleteMessage(target.dbId).catch(reportIpcError('agent.deleteMessage'))
    }
  }, [])

  // 点击历史会话 → 自动回填该会话最后使用的 Provider/模型
  const selectConversation = (id: string) => {
    setConversationId(id)
    const c = conversations.find((x) => x.id === id)
    if (c?.modelLabel) {
      // 格式："providerId:model" / 多目标 "pid1:m1 | pid2:m2" / Agent "agent:pid:model"
      const first = c.modelLabel.split('|')[0]?.trim() ?? ''
      const rest = first.startsWith('agent:') ? first.slice(6) : first
      const i = rest.indexOf(':')
      if (i > 0) {
        const pid = rest.slice(0, i)
        const mdl = rest.slice(i + 1)
        const p = providers.find((x) => x.id === pid)
        if (p) {
          setProviderId(pid)
          setModel(p.models.includes(mdl) ? mdl : '')
          return
        }
      }
    }
    // 回退：取最后一条 assistant 消息的 provider/model
    void window.pocketai.listMessages(id).then((msgs) => {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (!m) continue
        if (m.role === 'assistant' && m.provider && m.model) {
          const p = providers.find((x) => x.id === m.provider)
          if (p) {
            setProviderId(m.provider)
            setModel(p.models.includes(m.model) ? m.model : '')
          }
          break
        }
      }
    }).catch(reportIpcError('agent.restoreLastModel'))
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
      if (conversationIdRef.current === convId) {
        setLatestTraces(traces)
        setTracesLoading(false)
      }
    }).catch((e) => {
      reportIpcError('agent.getLatestRunTraces')(e)
      if (conversationIdRef.current === convId) setTracesLoading(false)
    })
  }, [])

  const send = (text: string, attachments: ChatAttachment[]) => {
    const content = text.trim()
    if (!content || !providerId || !model || !conversationId || running) return
    const requestId = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    requestIdRef.current = requestId

    // 立即插入用户消息到 UI
    dispatch({
      type: 'append',
      message: { id: `u_${Date.now()}`, role: 'user', text: content, attachments: [...attachments] }
    })
    setRunning(true)
    setInterrupted(false)
    setRunStats(null) // 新一轮运行：清除上轮统计，待 DONE 事件更新
    setLatestTraces(null) // 旧分步明细失效，下次展开重新拉取

    return window.pocketai.sendMessage({
      requestId,
      conversationId,
      assistantId: assistantId || null,
      content,
      targets: [{ providerId, model }],
      agentMode: true,
      attachments: attachments.length > 0 ? attachments : undefined
    })
  }

  const abort = () => {
    if (requestIdRef.current) window.pocketai.abortAgent(requestIdRef.current)
    setRunning(false)
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
   * 用相同文本与附件重新发起。Agent 为线性历史，不引入 Chat 的分支体系。
   * 仅对已持久化（有 dbId）的用户消息可用；DB 删除成功后才动 UI，失败仅记日志。
   */
  const rerun = async (id: string) => {
    if (running) return
    const target = messagesRef.current.find((m) => m.id === id)
    if (!target || target.role !== 'user' || !target.dbId || !target.text.trim()) return
    const text = target.text
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

  return {
    assistantId,
    setAssistantId,
    conversations,
    conversationId,
    messages,
    running,
    interrupted,
    runStats,
    latestTraces,
    tracesLoading,
    loadLatestTraces,
    providerId,
    model,
    setModel,
    selectedProvider,
    canSend,
    newConversation,
    deleteConversation,
    renameConversation,
    reloadConversations,
    deleteMessage,
    selectConversation,
    changeProvider,
    send,
    abort,
    resume,
    rerun
  }
}

export type AgentChat = ReturnType<typeof useAgentChat>
