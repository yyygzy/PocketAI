import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProviderRecord,
  AssistantRecord,
  ConversationRecord,
  MessageRecord,
  ChatTarget,
  ChatAttachment
} from '../../../../shared/types'
import { AssistantRail } from './AssistantRail'
import { AssistantMarket } from './AssistantMarket'
import { ConversationList } from './ConversationList'
import { ChatView } from './ChatView'
import { useStreamSession } from './useStreamSession'
import { useAppStore } from '../../store/app-store'
import { APP_SHORTCUT_EVENT, isActiveModuleInstance, type AppShortcutEventDetail } from '../../hooks/useGlobalShortcuts'
import { useI18n } from '../../i18n'
import { useToast } from '../../components/ToastProvider'
import { reportIpcError } from '../../utils/ipc'
import { errText } from '../../utils/error'
import { useConfirm } from '../../components/ConfirmDialog'
import { buildConversationHtml } from '../../utils/export-html'
import { capSelection, buildBatchExportFiles, finishBatchExport, BATCH_EXPORT_MAX, BATCH_PDF_MAX } from '../../utils/batch-export'

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
  const toast = useToast()
  const { confirm, dialog } = useConfirm()
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [currentAssistantId, setCurrentAssistantId] = useState<string>('asst-default')
  const [conversations, setConversations] = useState<ConversationRecord[]>([])
  const [archivedConversations, setArchivedConversations] = useState<ConversationRecord[]>([])
  const [currentConvId, setCurrentConvId] = useState<string | null>(null)
  const [messages, setMessages] = useState<MessageRecord[]>([])
  const [targets, setTargets] = useState<ChatTarget[]>([])
  const [marketOpen, setMarketOpen] = useState(false)
  const [marketDetailId, setMarketDetailId] = useState<string | undefined>(undefined)
  /** 搜索跳转定位的消息 id（消费后清空，传给 ChatView） */
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null)

  const assistantIdRef = useRef('asst-default')
  const currentConvRef = useRef<string | null>(null)
  currentConvRef.current = currentConvId
  // 标记用户是否在切换会话后手动改了模型；若改过则回填不再覆盖
  const userEditedTargetsRef = useRef(false)

  const reloadConversations = useCallback((autoSelect = false) => {
    const aid = assistantIdRef.current
    return Promise.all([
      window.pocketai.listConversations(aid, false, false),
      window.pocketai.listConversations(aid, false, true)
    ]).then(([list, archived]) => {
      setConversations(list)
      setArchivedConversations(archived)
      // 自动选中最近一次使用的会话（列表已按置顶权重+updated_at DESC 排序）
      if (autoSelect && list.length > 0 && !currentConvRef.current) {
        const first = list[0]!
        setCurrentConvId(first.id)
      }
    }).catch(reportIpcError('chat.listConversations'))
  }, [])

  const loadMessages = useCallback((convId: string) => {
    return window.pocketai.listMessages(convId).then(setMessages).catch(reportIpcError('chat.listMessages'))
  }, [])

  const reloadAssistants = useCallback(() => {
    return window.pocketai.listAssistants().then(setAssistants).catch(reportIpcError('chat.listAssistants'))
  }, [])

  // 流式会话收口：6 个流式 ref + liveColumns + focusBranch + 事件订阅全部内聚于 hook
  // 解构取稳定回调（useCallback []），避免以对象形式入 useCallback 依赖致其每渲染重建
  const {
    liveColumns, focusBranch, isStreaming, beginStream, failStream, focusNewBranch, abort
  } = useStreamSession({
    loadMessages,
    reloadConversations,
    getCurrentConvId: () => currentConvRef.current
  })

  // busy 上报：流式生成中豁免休眠，防止切走标签后被 LRU 卸载导致输出中断；
  // 重挂时 liveColumns 归 null，effect 自动重新上报 false
  useEffect(() => {
    useAppStore.getState().setModuleBusy('chat', liveColumns !== null)
  }, [liveColumns])

  // 初始加载（providers/assistants/conversations）；流式事件订阅已移入 useStreamSession
  useEffect(() => {
    // 同时拉取 provider 列表 + 向导上次保存的 provider id；
    // 命中且仍 enabled 则优先回填该 provider，否则回退到第一个 enabled provider
    Promise.all([
      window.pocketai.listProviders(),
      window.pocketai.getLastProvider()
    ]).then(([list, lastRes]) => {
      setProviders(list)
      const lastId = lastRes.ok ? lastRes.data : undefined
      const pick =
        (lastId ? list.find((p) => p.id === lastId && p.enabled) : undefined) ??
        list.filter((p) => p.enabled)[0]
      if (pick) {
        // 智能默认：跳过 embed/向量模型，选第一个对话模型
        const chatModel =
          pick.models.find((m) => !/^(bge[-_]|embed|gte[-_]|e5[-_]|minilm|nomic-embed)/i.test(m)) ??
          pick.models[0] ??
          ''
        setTargets([{ providerId: pick.id, model: chatModel }])
      }
    }).catch(reportIpcError('chat.listProviders'))

    window.pocketai.listAssistants().then((list) => {
      setAssistants(list)
      const def = list.find((a) => a.id === 'asst-default') ?? list[0]
      if (def) {
        assistantIdRef.current = def.id
        setCurrentAssistantId(def.id)
      }
      reloadConversations(true)
    }).catch(reportIpcError('chat.listAssistantsInit'))
  }, [reloadConversations])

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
    reloadConversations(true)

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
          if (!m) continue
          if (m.role === 'assistant' && m.provider && m.model) {
            applyPairs([{ providerId: m.provider, model: m.model }])
            break
          }
        }
      }).catch(reportIpcError('chat.restoreLastModel'))
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

  // 搜索跳转：切到目标会话并设 focusMessageId 让 ChatView 滚动+高亮
  const handleSelectMessage = useCallback((convId: string, messageId: string) => {
    userEditedTargetsRef.current = false
    setCurrentConvId(convId)
    loadMessages(convId)
    setFocusMessageId(messageId)
  }, [loadMessages])

  const handleNewConv = async () => {
    // 点击「新对话」直接在数据库创建一条对话记录，标题用当前助手名
    try {
      const title = currentAssistant?.name || t('chat.newConversation')
      const conv = await window.pocketai.createConversation(currentAssistantId, title)
      userEditedTargetsRef.current = false // 新对话允许模型回填
      setCurrentConvId(conv.id)
      setMessages([])
      await reloadConversations()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  // 应用内快捷键（中枢派发）：仅活动 chat 实例响应，防保活隐藏实例误触
  const shortcutConvRef = useRef({ newConv: () => {}, abort: () => {} })
  shortcutConvRef.current = { newConv: () => void handleNewConv(), abort }
  useEffect(() => {
    const onShortcut = (ev: Event) => {
      if (!isActiveModuleInstance('chat')) return
      const { action } = (ev as CustomEvent<AppShortcutEventDetail>).detail
      if (action === 'newConv') {
        shortcutConvRef.current.newConv()
      } else if (action === 'focusSearch') {
        requestAnimationFrame(() => {
          document.querySelector<HTMLInputElement>('[data-chat-search-input]')?.focus()
        })
      } else if (action === 'focusComposer') {
        document.querySelector<HTMLTextAreaElement>('[data-chat-composer-input]')?.focus()
      } else if (action === 'abort') {
        shortcutConvRef.current.abort()
      }
    }
    window.addEventListener(APP_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(APP_SHORTCUT_EVENT, onShortcut)
  }, [])

  // 智能标题后台生成完成：就地更新活跃/归档两个列表（流式结束后的 reload 为兜底）
  useEffect(() => {
    return window.pocketai.onConversationTitle(({ conversationId, title }) => {
      const patch = (list: ConversationRecord[]) =>
        list.map((c) => (c.id === conversationId ? { ...c, title } : c))
      setConversations(patch)
      setArchivedConversations(patch)
    })
  }, [])

  const handleRenameConv = async (id: string, title: string) => {
    try {
      await window.pocketai.renameConversation(id, title)
      await reloadConversations()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  const handleEditAssistant = (id: string) => {
    setMarketDetailId(id)
    setMarketOpen(true)
  }

  const handleDeleteConv = async (id: string) => {
    try {
      await window.pocketai.deleteConversation(id)
      if (currentConvId === id) {
        setCurrentConvId(null)
        setMessages([])
      }
      await reloadConversations()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  const handleTogglePin = async (id: string, pinned: boolean) => {
    try {
      await window.pocketai.setConversationPinned(id, pinned)
      await reloadConversations()
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  // 归档：仅列表层面隐藏，内容区与视图不切换；取消归档即时回主列表
  const handleSetArchived = async (id: string, archived: boolean) => {
    try {
      await window.pocketai.setConversationArchived(id, archived)
      await reloadConversations()
      if (archived) toast.info(t('chat.archivedHint'))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }

  const handleExportConv = async (id: string) => {
    try {
      const r = await window.pocketai.exportConversationMd(id)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      if (r.path) {
        toast.success(t('chat.exportSuccess', { path: r.path }))
      }
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }

  // HTML 导出：渲染端生成自包含 HTML（复用 Markdown 渲染管线），主进程存盘
  const handleExportHtml = async (id: string) => {
    try {
      const conv = conversations.find((c) => c.id === id)
      if (!conv) {
        toast.error(t('chat.exportFail', { e: t('common.unknownError') }))
        return
      }
      const msgs = await window.pocketai.listMessages(id)
      const assistantName = conv.assistantId
        ? assistants.find((a) => a.id === conv.assistantId)?.name ?? null
        : null
      const html = await buildConversationHtml(conv, msgs, assistantName)
      const r = await window.pocketai.exportConversationHtml(id, html)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      if (r.path) toast.success(t('chat.exportSuccess', { path: r.path }))
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }

  // PDF 导出：同一自包含 HTML 交给主进程隐藏窗口 printToPDF（见 main/export/pdf.ts）
  const handleExportPdf = async (id: string) => {
    try {
      const conv = conversations.find((c) => c.id === id)
      if (!conv) {
        toast.error(t('chat.exportFail', { e: t('common.unknownError') }))
        return
      }
      const msgs = await window.pocketai.listMessages(id)
      const assistantName = conv.assistantId
        ? assistants.find((a) => a.id === conv.assistantId)?.name ?? null
        : null
      const html = await buildConversationHtml(conv, msgs, assistantName)
      const r = await window.pocketai.exportConversationPdf(id, html)
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      if (r.path) toast.success(t('chat.exportSuccess', { path: r.path }))
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }

  // 批量导出：convs 缺省 = 当前助手全部会话；传入 = 多选导出（重名由主进程加序号）
  // pdf 逐会话 printToPDF 耗时高，选中上限收紧为 BATCH_PDF_MAX
  const batchBusyRef = useRef(false)
  const handleBatchExport = async (format: 'md' | 'html' | 'pdf', convs?: ConversationRecord[]) => {
    if (batchBusyRef.current) return
    batchBusyRef.current = true
    try {
      const list = convs ?? (await window.pocketai.listConversations(assistantIdRef.current, false))
      if (list.length === 0) {
        toast.info(t('chat.exportBatchEmpty'))
        return
      }
      const max = format === 'pdf' ? BATCH_PDF_MAX : BATCH_EXPORT_MAX
      let selected = list
      if (convs) {
        const capped = capSelection(convs, max)
        selected = capped.list
        if (capped.dropped > 0) {
          toast.info(t('chat.exportMultiCapped', { max, dropped: capped.dropped }))
        }
      }
      const files = await buildBatchExportFiles({
        convs: selected,
        format,
        listMessages: (id) => window.pocketai.listMessages(id),
        resolveAssistantName: (assistantId) =>
          assistantId ? assistants.find((a) => a.id === assistantId)?.name ?? null : null
      })
      const outcome = await finishBatchExport(files, format)
      if (outcome.kind === 'failed') {
        toast.error(t('chat.exportFail', { e: outcome.error || t('common.unknownError') }))
      } else if (outcome.kind === 'done') {
        const warn = outcome.failedCount > 0 ? `（${outcome.failedCount} ${t('chat.exportBatchFailed')}）` : ''
        toast.success(`${t('chat.exportBatchDone', { n: outcome.count, dir: outcome.dir })}${warn}`)
      }
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    } finally {
      batchBusyRef.current = false
    }
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
        if (!r.ok) { toast.error(t('chat.importFail', { e: r.error ?? t('common.unknownError') })); return }
        toast.success(t('chat.importOk', { n: r.messageCount ?? 0 }))
        await reloadConversations()
      } catch (e) {
        toast.error(t('chat.importFail', { e: errText(e) }))
      }
    }
    input.click()
  }

  // ---------- 加密导出/导入 ----------
  const [cryptoPrompt, setCryptoPrompt] = useState<null | { kind: 'export' | 'import'; id?: string }>(null)
  const [cryptoPwd, setCryptoPwd] = useState('')

  const handleExportEncrypted = (id: string) => {
    setCryptoPwd('')
    setCryptoPrompt({ kind: 'export', id })
  }
  const handleImportEncrypted = () => {
    setCryptoPwd('')
    setCryptoPrompt({ kind: 'import' })
  }
  const confirmCrypto = async () => {
    if (!cryptoPrompt) return
    const kind = cryptoPrompt.kind
    const pwd = cryptoPwd
    setCryptoPrompt(null); setCryptoPwd('')
    try {
      if (kind === 'export') {
        const r = await window.pocketai.exportConversationEncrypted(cryptoPrompt.id!, pwd)
        if (r.canceled) return
        if (!r.ok) { toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') })); return }
        toast.success(t('chat.exportSuccess', { path: r.path ?? '' }))
      } else {
        const r = await window.pocketai.importConversationEncrypted(pwd)
        if (r.canceled) return
        if (!r.ok) { toast.error(t('chat.importFail', { e: r.error ?? t('common.unknownError') })); return }
        toast.success(t('chat.importOk', { n: r.messageCount ?? 0 }))
        await reloadConversations()
      }
    } catch (e) {
      // IPC 层 reject（对话框打开失败/通道异常）：按导出/导入方向给出可见反馈
      toast.error(t(kind === 'export' ? 'chat.exportFail' : 'chat.importFail', { e: errText(e) }))
    }
  }

  const handleTargetsChange = (next: ChatTarget[]) => {
    userEditedTargetsRef.current = true
    setTargets(next)
  }

  const handleSend = async (text: string, attachments?: ChatAttachment[]) => {
    if (isStreaming()) return
    const validTargets = targets.filter((t) => t.providerId && t.model)
    if (validTargets.length === 0) return

    // 视觉模型校验：如果有图片附件但模型名不支持 vision，弹出警告
    if (attachments && attachments.some((a) => a.type === 'image')) {
      const VISION_MODEL_PATTERNS = /gpt-4o|gpt-4-vision|claude-3|claude-4|gemini.*vision|gemini.*pro|doubao-vision|qwen-vl|qwen2-vl|llava|vision/i
      const nonVisionTargets = validTargets.filter((t) => !VISION_MODEL_PATTERNS.test(t.model))
      if (nonVisionTargets.length > 0) {
        const modelList = nonVisionTargets.map((t) => t.model).join(', ')
        if (!(await confirm({ message: t('chatview.visionWarn', { models: modelList }) }))) {
          return
        }
      }
    }

    let convId = currentConvId
    if (!convId) {
      const c = await window.pocketai.createConversation(currentAssistantId)
      convId = c.id
      setCurrentConvId(convId)
      await reloadConversations()
    }

    setMessages((prev) => [...prev, tempMessage('user', text)])

    const requestId = beginStream(convId, validTargets)
    if (!requestId) return

    window.pocketai
      .sendMessage({
        requestId,
        conversationId: convId,
        assistantId: currentAssistantId,
        content: text,
        targets: validTargets,
        attachments
      })
      .catch(() => {
        failStream(requestId, convId)
      })
  }

  const handleStop = () => {
    abort()
  }

  const handleDeleteMessage = useCallback(async (id: string) => {
    try {
      await window.pocketai.deleteMessage(id)
      if (currentConvId) loadMessages(currentConvId)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }, [currentConvId, loadMessages, toast, t])

  const handleDeleteMessages = useCallback(async (ids: string[]) => {
    try {
      await Promise.all(ids.map((id) => window.pocketai.deleteMessage(id)))
      if (currentConvId) loadMessages(currentConvId)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }, [currentConvId, loadMessages, toast, t])

  const handleRegenerate = useCallback(async (messageId: string) => {
    if (isStreaming()) return // 正在流式中
    const validTargets = targets.filter((t) => t.providerId && t.model)
    if (validTargets.length === 0 || !currentConvId) return

    const requestId = beginStream(currentConvId, validTargets)
    if (!requestId) return

    // 旧回复保留为分支；新分支生成中由 liveColumns 以虚拟批次显示
    // 生成完成后自动把该轮切到新分支（batchId = requestId）
    const old = messages.find((m) => m.id === messageId)
    const turnKey = old?.parentId ?? messageId
    focusNewBranch(turnKey, requestId)

    window.pocketai
      .regenerateMessage({
        requestId,
        conversationId: currentConvId,
        assistantId: currentAssistantId,
        messageId,
        targets: validTargets
      })
      .catch(() => {
        failStream(requestId, currentConvId)
      })
  }, [targets, currentConvId, currentAssistantId, messages, isStreaming, beginStream, focusNewBranch, failStream])

  /** 改参重跑 / 编辑用户消息后重发：旧回复保留为分支，追加新批次 */
  const handleResend = useCallback(async (messageId: string, newContent?: string) => {
    if (isStreaming()) return // 正在流式中
    const validTargets = targets.filter((t) => t.providerId && t.model)
    if (validTargets.length === 0 || !currentConvId) return

    const requestId = beginStream(currentConvId, validTargets)
    if (!requestId) return

    // 本地乐观更新用户消息内容；旧回复保留为分支，由 liveColumns 以虚拟批次显示
    if (newContent !== undefined) {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, content: newContent } : m)))
    }
    focusNewBranch(messageId, requestId)

    window.pocketai
      .resendMessage({
        requestId,
        conversationId: currentConvId,
        assistantId: currentAssistantId,
        messageId,
        content: newContent,
        targets: validTargets
      })
      .catch(() => {
        failStream(requestId, currentConvId)
      })
  }, [targets, currentConvId, currentAssistantId, isStreaming, beginStream, focusNewBranch, failStream])

  /** 消息分支：从指定消息分叉出新会话并立即跳转 */
  const handleForkConversation = useCallback(async (messageId: string) => {
    if (!currentConvId) return
    const r = await window.pocketai.forkConversation(currentConvId, messageId)
    if (!r.ok || !r.conversation) {
      toast.error(r.error ?? t('chatview.forkFailed'))
      return
    }
    await reloadConversations()
    userEditedTargetsRef.current = false
    setCurrentConvId(r.conversation.id)
    await loadMessages(r.conversation.id)
    restoreLastModel(r.conversation)
  }, [currentConvId, reloadConversations, loadMessages, restoreLastModel, toast, t])

  // 另存为笔记：取消息内容创建笔记，然后跳到笔记模块并选中
  const handleSaveAsNote = useCallback(async (messageId: string) => {
    const msg = messages.find((m) => m.id === messageId)
    if (!msg) return
    try {
      const note = await window.pocketai.createNoteFromMessage({ content: msg.content ?? '' })
      window.dispatchEvent(new CustomEvent('pocketai:switch-module', { detail: { moduleId: 'notes' } }))
      window.dispatchEvent(new CustomEvent('pocketai:open-note', { detail: { id: note.id } }))
    } catch (e) {
      // 主进程版本过旧/未重启时 IPC 无 handler，需给出明确提示而非静默无反应
      toast.error(t('chatview.saveNoteFailed', { msg: errText(e) }))
    }
  }, [messages, toast, t])

  return (
    <div className="flex h-full min-w-0 relative">
      {/* 左栏：助手 + 该助手的会话 */}
      <div className="w-60 shrink-0 flex flex-col bg-[var(--color-sidebar)] border-r border-[var(--color-border)]">
        <AssistantRail
          assistants={assistants}
          activeId={currentAssistantId}
          onSelect={handleSelectAssistant}
          onEdit={handleEditAssistant}
          onOpenMarket={() => { setMarketDetailId(undefined); setMarketOpen(true) }}
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
            onExportHtml={handleExportHtml}
            onExportPdf={handleExportPdf}
            onExportEncrypted={handleExportEncrypted}
            onBatchExport={handleBatchExport}
            onBatchExportSelected={(fmt, convs) => void handleBatchExport(fmt, convs)}
            onImport={handleImportConv}
            onImportEncrypted={handleImportEncrypted}
            onSelectMessage={handleSelectMessage}
            archivedConversations={archivedConversations}
            onTogglePin={handleTogglePin}
            onSetArchived={handleSetArchived}
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
        onSend={handleSend}
        onStop={handleStop}
        onRegenerate={handleRegenerate}
        onResend={handleResend}
        onDeleteMessage={handleDeleteMessage}
        onDeleteMessages={handleDeleteMessages}
        onForkConversation={handleForkConversation}
        onSaveAsNote={handleSaveAsNote}
        focusBranch={focusBranch}
        focusMessageId={focusMessageId}
      />

      {marketOpen && (
        <AssistantMarket
          providers={providers}
          onClose={() => { setMarketOpen(false); setMarketDetailId(undefined) }}
          onChanged={reloadAssistants}
          initialDetailId={marketDetailId}
          onUse={(id) => {
            handleSelectAssistant(id)
            handleNewConv()
            setMarketOpen(false)
            setMarketDetailId(undefined)
          }}
        />
      )}

      {/* 密码弹窗 — 加密导出/导入 */}
      {cryptoPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setCryptoPrompt(null)}>
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-96 p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">
              {cryptoPrompt.kind === 'export' ? t('chatview.exportTitle') : t('chatview.importTitle')}
            </h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-4">
              {cryptoPrompt.kind === 'export'
                ? t('chatview.exportPwdHint')
                : t('chatview.importPwdHint')}
            </p>
            <input
              type="password"
              autoFocus
              value={cryptoPwd}
              onChange={(e) => setCryptoPwd(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') confirmCrypto(); if (e.key === 'Escape') setCryptoPrompt(null) }}
              placeholder={t('common.enterPassword')}
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-input-bg)] text-sm outline-none focus:border-[var(--color-accent)]"
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button onClick={() => setCryptoPrompt(null)} className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover)]">{t('common.cancel')}</button>
              <button onClick={confirmCrypto} disabled={!cryptoPwd} className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded disabled:opacity-50 hover:opacity-90">
                {cryptoPrompt.kind === 'export' ? t('chatview.export') : t('chatview.decryptImport')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog}
    </div>
  )
}
