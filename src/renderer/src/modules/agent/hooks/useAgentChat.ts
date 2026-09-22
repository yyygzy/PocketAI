// Agent 对话核心：助手/会话/消息流（reducer）/运行状态/Provider·模型选择/发送与中止
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type {
  AgentDoneEvent,
  AgentErrorEvent,
  AgentStepEvent,
  ChatAttachment,
  MessageRecord,
  ProviderRecord
} from '../../../../../shared/types'
import { useI18n } from '../../../i18n'
import { toAgentMessages, type AgentMessage } from '../agent-shared'
import { messagesReducer } from './messages-reducer'

export function useAgentChat(providers: ProviderRecord[]) {
  const { t } = useI18n()
  const [assistantId, setAssistantId] = useState('')
  const [conversations, setConversations] = useState<import('../../../../../shared/types').ConversationRecord[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [messages, dispatch] = useReducer(messagesReducer, [] as AgentMessage[])
  const [running, setRunning] = useState(false)
  const [providerId, setProviderId] = useState('')
  const [model, setModel] = useState('')
  const requestIdRef = useRef('')

  const selectedProvider = useMemo(
    () => providers.find((p) => p.id === providerId),
    [providers, providerId]
  )

  // 助手切换 → 拉会话列表并自动选中最近一次（列表已按 updated_at DESC 排序）
  useEffect(() => {
    if (!assistantId) return
    void window.pocketai.listConversations(assistantId, true).then((list) => {
      setConversations(list)
      setConversationId(list.length > 0 ? list[0].id : null)
    })
  }, [assistantId])

  // 会话切换 → 加载历史消息
  useEffect(() => {
    if (!conversationId) {
      dispatch({ type: 'clear' })
      return
    }
    void window.pocketai.listMessages(conversationId).then((dbMsgs: MessageRecord[]) => {
      dispatch({ type: 'load', messages: toAgentMessages(dbMsgs) })
    })
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
      window.pocketai.onAgentDone((_e: AgentDoneEvent) => setRunning(false))
    )
    offs.push(
      window.pocketai.onAgentError((_e: AgentErrorEvent) => setRunning(false))
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
        if (m.role === 'assistant' && m.provider && m.model) {
          const p = providers.find((x) => x.id === m.provider)
          if (p) {
            setProviderId(m.provider)
            setModel(p.models.includes(m.model) ? m.model : '')
          }
          break
        }
      }
    })
  }

  /** 切换 Provider 时清空模型选择 */
  const changeProvider = (id: string) => {
    setProviderId(id)
    setModel('')
  }

  const canSend = !!providerId && !!model && !!conversationId && !!assistantId

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

  return {
    assistantId,
    setAssistantId,
    conversations,
    conversationId,
    messages,
    running,
    providerId,
    model,
    setModel,
    selectedProvider,
    canSend,
    newConversation,
    deleteConversation,
    selectConversation,
    changeProvider,
    send,
    abort
  }
}

export type AgentChat = ReturnType<typeof useAgentChat>
