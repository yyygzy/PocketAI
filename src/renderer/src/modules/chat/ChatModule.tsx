import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProviderRecord,
  AssistantRecord,
  ConversationRecord,
  MessageRecord,
  ChatTarget
} from '../../../../shared/types'
import { AssistantRail } from './AssistantRail'
import { AssistantMarket } from './AssistantMarket'
import { ConversationList } from './ConversationList'
import { ChatView } from './ChatView'
import type { CompareColumn } from './ComparisonColumns'
import { useI18n } from '../../i18n'

function tempMessage(role: 'user' | 'assistant', content: string, model?: string): MessageRecord {
  return {
    id: `temp-${crypto.randomUUID()}`,
    conversationId: '',
    role,
    content,
    provider: null,
    model: model ?? null,
    status: role === 'assistant' ? 'streaming' : 'done',
    parentId: null,
    createdAt: Date.now()
  }
}

export const ChatModule: React.FC = () => {
  const { t } = useI18n()
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [currentAssistantId, setCurrentAssistantId] = useState<string>('asst-default')
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [currentConvId, setCurrentConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [targets, setTargets] = useState<ChatTarget[]>([])
  const [liveColumns, setLiveColumns] = useState<CompareColumn[] | null>(null)
  const [marketOpen, setMarketOpen] = useState(false)
  const [tempPrompt, setTempPrompt] = useState('')

  const requestIdRef = useRef<string | null>(null)
  const finalizedRef = useRef(false)
  const totalColumnsRef = useRef(0)
  const settledCountRef = useRef(0)
  const assistantIdRef = useRef('asst-default')
  const streamingConvRef = useRef<string | null>(null)
  const currentConvRef = useRef<string | null>(null)
  currentConvRef.current = currentConvId
  // 标记用户是否在切换会话后手动改了模型；若改过则回填不再覆盖
  const userEditedTargetsRef = useRef(false)

  const reloadConversations = useCallback(() => {
    return window.pocketai.listConversations(assistantIdRef.current).then(setConversations)
  }, [])

  const loadMessages = useCallback((convId: string) => {
    return window.pocketai.listMessages(convId).then(setMessages)
  }, [])

  const reloadAssistants = useCallback(() => {
    return window.pocketai.listAssistants().then(setAssistants)
  }, [])

  // 初始加载 + 订阅流式事件
  useEffect(() => {
    window.pocketai.listProviders().then((list) => {
      setProviders(list)
      const first = list.filter((p) => p.enabled)[0]
      if (first) {
        // 智能默认：跳过 embed/向量模型，选第一个对话模型
        const chatModel = first.models.find((m) => !/^(bge[-_]|embed|gte[-_]|e5[-_]|minilm|nomic-embed)/i.test(m)) ?? first.models[0] ?? ''
        setTargets([{ providerId: first.id, model: chatModel }])
      }
    })

    window.pocketai.listAssistants().then((list) => {
      setAssistants(list)
      const def = list.find((a) => a.id === 'asst-default') ?? list[0]
      if (def) {
        assistantIdRef.current = def.id
        setCurrentAssistantId(def.id)
      }
      reloadConversations()
    })

    const offChunk = window.pocketai.onChatChunk((e) => {
      if (e.requestId !== requestIdRef.current) return
      setLiveColumns((prev) => {
        if (!prev) return prev
        return prev.map((c, i) =>
          i === e.targetIndex ? { ...c, content: c.content + e.delta } : c
        )
      })
    })

    const markSettled = (requestId: string, index: number, patch: Partial<CompareColumn>) => {
      setLiveColumns((prev) =>
        prev ? prev.map((c, i) => (i === index ? { ...c, ...patch } : c)) : prev
      )
      settledCountRef.current += 1
      if (!finalizedRef.current && settledCountRef.current >= totalColumnsRef.current) {
        finalize(requestId)
      }
    }

    const offDone = window.pocketai.onChatDone((e) => {
      if (e.requestId === requestIdRef.current) markSettled(e.requestId, e.targetIndex, { status: 'done' })
    })
    const offError = window.pocketai.onChatError((e) => {
      if (e.requestId === requestIdRef.current) markSettled(e.requestId, e.targetIndex, { status: 'error', error: e.error })
    })

    function finalize(requestId: string) {
      if (finalizedRef.current) return
      finalizedRef.current = true
      const convId = streamingConvRef.current
      requestIdRef.current = null
      streamingConvRef.current = null
      setTimeout(() => {
        setLiveColumns(null)
        reloadConversations()
        if (convId && currentConvRef.current === convId) loadMessages(convId)
      }, 200)
    }

    return () => {
      offChunk()
      offDone()
      offError()
    }
  }, [reloadConversations, loadMessages])

  const currentAssistant = assistants.find((a) => a.id === currentAssistantId) ?? null

  // 对话配置条更新助手（技能/知识库/工具权限）
  const handleAssistantUpdated = (updated: AssistantRecord) => {
    setAssistants((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
  }

  const handleSelectAssistant = (id: string) => {
    assistantIdRef.current = id
    setCurrentAssistantId(id)
    setCurrentConvId(null)
    setMessages([])
    reloadConversations()

    // 应用助手默认模型（助手级参数）；未配置则保留当前全局选择
    const asst = assistants.find((a) => a.id === id)
    if (asst?.defaultProviderId && asst.defaultModel) {
      setTargets([{ providerId: asst.defaultProviderId, model: asst.defaultModel }])
    }
  }

  // 根据会话记录回填最后使用的模型（含多模型对照整组恢复）
  // 修复：若用户在切换会话后手动改了模型，不再用异步回填覆盖
  const restoreLastModel = useCallback(
    (conv: ConversationRecord) => {
      const applyPairs = (pairs: { providerId: string; model: string }[]) => {
        if (userEditedTargetsRef.current) return // 用户已手动选择，尊重用户
        const valid = pairs.filter((p) => {
          const prov = providers.find((x) => x.id === p.providerId)
          return prov && prov.models.includes(p.model)
        })
        if (valid.length) setTargets(valid)
      }

      // 优先用会话的 modelLabel："pid1:m1 | pid2:m2"，Agent 前缀 "agent:pid:model"
      if (conv.modelLabel) {
        const pairs = conv.modelLabel
          .split('|')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const rest = s.startsWith('agent:') ? s.slice(6) : s
            const i = rest.indexOf(':')
            return i > 0 ? { providerId: rest.slice(0, i), model: rest.slice(i + 1) } : null
          })
          .filter((p): p is { providerId: string; model: string } => !!p)
        if (pairs.length) {
          applyPairs(pairs)
          return
        }
      }

      // 回退：最后一条 assistant 消息的 provider/model（异步，需防覆盖）
      window.pocketai.listMessages(conv.id).then((msgs) => {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m.role === 'assistant' && m.provider && m.model) {
            applyPairs([{ providerId: m.provider, model: m.model }])
            break
          }
        }
      })
    },
    [providers]
  )

  const handleSelectConv = (id: string) => {
    userEditedTargetsRef.current = false // 切换会话时重置，允许回填
    setCurrentConvId(id)
    loadMessages(id)
    const conv = conversations.find((c) => c.id === id)
    if (conv) restoreLastModel(conv)
  }

  const handleNewConv = async () => {
    // 点击「新对话」直接在数据库创建一条对话记录，标题用当前助手名
    const title = currentAssistant?.name || t('chat.newConversation')
    const conv = await window.pocketai.createConversation(currentAssistantId, title)
    userEditedTargetsRef.current = false // 新对话允许模型回填
    setCurrentConvId(conv.id)
    setMessages([])
    await reloadConversations()
  }

  const handleRenameConv = async (id: string, title: string) => {
    await window.pocketai.renameConversation(id, title)
    await reloadConversations()
  }

  const handleDeleteAssistant = async (id: string) => {
    await window.pocketai.deleteAssistant(id)
    if (currentAssistantId === id) {
      // 切到第一个可用助手
      const next = assistants.find((a) => a.id !== id)
      if (next) handleSelectAssistant(next.id)
    }
    await reloadAssistants()
  }

  const handleDeleteConv = async (id: string) => {
    await window.pocketai.deleteConversation(id)
    if (currentConvId === id) {
      setCurrentConvId(null)
      setMessages([])
    }
    await reloadConversations()
  }

  const handleExportConv = async (id: string) => {
    const r = await window.pocketai.exportConversation(id)
    if (!r.ok || !r.data) {
      alert(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
      return
    }
    const blob = new Blob([JSON.stringify(r.data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const title = r.data.conversation?.title ?? 'conversation'
    a.href = url
    a.download = `pocketai-${title}-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleImportConv = async () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      try {
        const text = await file.text()
        const payload = JSON.parse(text)
        const r = await window.pocketai.importConversation(payload)
        if (!r.ok) { alert(t('chat.importFail', { e: r.error ?? t('common.unknownError') })); return }
        alert(t('chat.importOk', { n: r.messageCount ?? 0 }))
        await reloadConversations()
      } catch (e: any) {
        alert(t('chat.importFail', { e: e.message }))
      }
    }
    input.click()
  }

  const handleTargetsChange = (next: ChatTarget[]) => {
    userEditedTargetsRef.current = true
    setTargets(next)
  }

  const handleSend = async (text: string) => {
    if (requestIdRef.current) return
    const validTargets = targets.filter((t) => t.providerId && t.model)
    if (validTargets.length === 0) return

    let convId = currentConvId
    if (!convId) {
      const c = await window.pocketai.createConversation(currentAssistantId)
      convId = c.id
      setCurrentConvId(convId)
      await reloadConversations()
    }

    setMessages((prev) => [...prev, tempMessage('user', text)])

    const requestId = crypto.randomUUID()
    requestIdRef.current = requestId
    finalizedRef.current = false
    totalColumnsRef.current = validTargets.length
    settledCountRef.current = 0
    streamingConvRef.current = convId
    setLiveColumns(
      validTargets.map((t) => ({
        providerId: t.providerId,
        model: t.model,
        content: '',
        status: 'streaming' as const
      }))
    )

    window.pocketai
      .sendMessage({
        requestId,
        conversationId: convId,
        assistantId: currentAssistantId,
        content: text,
        targets: validTargets,
        ...(tempPrompt.trim() ? { systemPrompt: tempPrompt.trim() } : {})
      })
      .catch(() => {
        if (requestIdRef.current === requestId) {
          requestIdRef.current = null
          streamingConvRef.current = null
          setLiveColumns(null)
          if (convId && currentConvRef.current === convId) loadMessages(convId)
        }
      })
  }

  const handleStop = () => {
    if (requestIdRef.current) window.pocketai.abortChat(requestIdRef.current)
  }

  return (
    <div className="flex h-full min-w-0 relative">
      {/* 左栏：助手 + 该助手的会话 */}
      <div className="w-60 shrink-0 flex flex-col bg-[var(--color-sidebar)] border-r border-[var(--color-border)]">
        <AssistantRail
          assistants={assistants}
          activeId={currentAssistantId}
          onSelect={handleSelectAssistant}
          onDelete={handleDeleteAssistant}
          onOpenMarket={() => setMarketOpen(true)}
        />
        <div className="flex-1 min-h-0 flex flex-col">
          <ConversationList
            conversations={conversations}
            currentId={currentConvId}
            onSelect={handleSelectConv}
            onNew={handleNewConv}
            onDelete={handleDeleteConv}
            onRename={handleRenameConv}
            onExport={handleExportConv}
            onImport={handleImportConv}
            embedded
          />
        </div>
      </div>

      <ChatView
        providers={providers}
        targets={targets}
        onTargetsChange={handleTargetsChange}
        messages={messages}
        liveColumns={liveColumns}
        welcomeMessage={currentAssistant?.welcomeMessage}
        assistantName={currentAssistant?.name}
        assistant={currentAssistant}
        onAssistantUpdated={handleAssistantUpdated}
        tempPrompt={tempPrompt}
        onTempPromptChange={setTempPrompt}
        onSend={handleSend}
        onStop={handleStop}
      />

      {marketOpen && (
        <AssistantMarket
          providers={providers}
          onClose={() => setMarketOpen(false)}
          onChanged={reloadAssistants}
          onUse={(id) => {
            handleSelectAssistant(id)
            handleNewConv()
            setMarketOpen(false)
          }}
        />
      )}
    </div>
  )
}
