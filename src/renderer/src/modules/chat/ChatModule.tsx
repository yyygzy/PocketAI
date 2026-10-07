import React, { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ProviderRecord,
  AssistantRecord,
  ConversationRecord,
  ConversationGroupRecord,
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
import { buildMessagesMarkdown } from '../../../../shared/export-markdown'
import { capSelection, buildBatchExportFiles, finishBatchExport, BATCH_EXPORT_MAX, BATCH_PDF_MAX } from '../../utils/batch-export'
import { consumePendingUsageJump, USAGE_JUMP_EVENT } from '../settings/usage-jump'
import { consumePendingOpenConversation, OPEN_CONVERSATION_EVENT, type OpenConversationDetail } from '../../utils/palette-nav'
import { buildReminderText } from '../../utils/reminder-presets'
import { formatDateTime } from '../../utils/time'

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
  const [replyToMessage, setReplyToMessage] = useState<MessageRecord | null>(null)
  const [targets, setTargets] = useState<ChatTarget[]>([])
  const [marketOpen, setMarketOpen] = useState(false)
  const [marketDetailId, setMarketDetailId] = useState<string | undefined>(undefined)
  /** 搜索跳转定位的消息 id（消费后清空，传给 ChatView） */
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null)
  /** 当前会话已加载的草稿文本（切会话同步清空，异步加载后回填） */
  const [activeDraft, setActiveDraft] = useState('')
  /** 当前助手维度的分组文件夹（随 reloadConversations 一并拉取） */
  const [groups, setGroups] = useState<ConversationGroupRecord[]>([])

  const assistantIdRef = useRef('asst-default')
  const currentConvRef = useRef<string | null>(null)
  currentConvRef.current = currentConvId
  // 标记用户是否在切换会话后手动改了模型；若改过则回填不再覆盖
  const userEditedTargetsRef = useRef(false)
  // 草稿防抖句柄 + 最新文本镜像（卸载/关闭时尽力落库）
  const draftTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftTextRef = useRef('')
  // 空会话清理所需镜像：供切换入口的稳定回调读取最新消息/列表（避免 useCallback 闭包陈旧）
  const messagesRef = useRef<MessageRecord[]>([])
  useEffect(() => { messagesRef.current = messages }, [messages])
  const convIndexRef = useRef<Map<string, ConversationRecord>>(new Map())
  useEffect(() => {
    const idx = new Map<string, ConversationRecord>()
    for (const c of [...conversations, ...archivedConversations]) idx.set(c.id, c)
    convIndexRef.current = idx
  }, [conversations, archivedConversations])

  const reloadConversations = useCallback((autoSelect = false) => {
    const aid = assistantIdRef.current
    return Promise.all([
      window.pocketai.listConversations(aid, false, false),
      window.pocketai.listConversations(aid, false, true),
      window.pocketai.listConversationGroups(aid)
    ]).then(([list, archived, groupList]) => {
      setConversations(list)
      setArchivedConversations(archived)
      setGroups(groupList)
      // 自动选中最近一次使用的会话（列表已按置顶权重+updated_at DESC 排序）
      if (autoSelect && list.length > 0 && !currentConvRef.current) {
        const first = list[0]!
        setCurrentConvId(first.id)
      }
      return list
    }).catch((e) => {
      reportIpcError('chat.listConversations')(e)
      return []
    })
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
    getCurrentConvId: () => currentConvRef.current,
    // 回复完成通知：仅窗口不可见或失焦时弹（前台不打扰）；开关关闭/异常一律静默
    onStreamsSettled: (convId, outcome) => {
      if (!document.hidden && document.hasFocus()) return
      void (async () => {
        try {
          if (!(await window.pocketai.getReplyNotifyEnabled())) return
          const conv = conversations.find((c) => c.id === convId)
          const asst = assistants.find((a) => a.id === (conv?.assistantId ?? currentAssistantId))
          const title = asst?.name || 'PocketAI'
          const body = outcome === 'done'
            ? t('notify.replyDoneBody', { title: conv?.title ?? '' })
            : t('notify.replyErrorBody')
          await window.pocketai.showReplyNotification({ title, body })
        } catch {
          /* 通知失败不影响主流程 */
        }
      })()
    }
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
      // 先清扫历史版本/崩溃前遗留的空壳会话，再拉列表自动选中（清扫失败不阻断加载）
      window.pocketai
        .cleanupEmptyConversations()
        .catch(reportIpcError('chat.cleanupEmptyConversations'))
        .finally(() => { void reloadConversations(true) })
    }).catch(reportIpcError('chat.listAssistantsInit'))
  }, [reloadConversations])

  const currentAssistant = assistants.find((a) => a.id === currentAssistantId) ?? null

  // 对话配置条更新助手（技能/知识库/工具权限）
  const handleAssistantUpdated = (updated: AssistantRecord) => {
    setAssistants((prev) => prev.map((a) => (a.id === updated.id ? updated : a)))
  }

  const handleSelectAssistant = (id: string) => {
    discardCurrentIfEmpty()
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

  /** 落库草稿并同步列表 📝 标记（空文本=删除草稿行）；清待发防抖由调用方负责 */
  const saveDraft = useCallback((convId: string, text: string) => {
    const has = text.trim().length > 0
    window.pocketai
      .setConversationDraft(convId, has ? text : '')
      .then(() => {
        // 本地同步列表标记，避免等下次 reload
        const patch = (list: ConversationRecord[]) =>
          list.some((c) => c.id === convId && !!c.hasDraft !== has)
            ? list.map((c) => (c.id === convId ? { ...c, hasDraft: has } : c))
            : list
        setConversations((prev) => patch(prev))
        setArchivedConversations((prev) => patch(prev))
      })
      .catch(reportIpcError('chat.setConversationDraft'))
  }, [])

  /** 每键回调：非空防抖 600ms 落库；空串立即删除（发送/手动清空场景） */
  const handleDraftChange = useCallback((text: string) => {
    const id = currentConvRef.current
    draftTextRef.current = text
    if (!id) return
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = undefined
    }
    if (!text.trim()) {
      saveDraft(id, '')
      return
    }
    draftTimerRef.current = setTimeout(() => {
      draftTimerRef.current = undefined
      saveDraft(id, draftTextRef.current)
    }, 600)
  }, [saveDraft])

  /** 切会话时 Composer 同步提交旧会话未防抖文本 */
  const commitDraft = useCallback((convId: string, text: string) => {
    draftTextRef.current = text
    if (draftTimerRef.current) {
      clearTimeout(draftTimerRef.current)
      draftTimerRef.current = undefined
    }
    saveDraft(convId, text)
  }, [saveDraft])

  // 会话切换统一加载草稿（手动切换/新对话/初始自动选中/搜索跳转全覆盖）；
  // 同步清空防旧会话文本闪现，异步加载完成后回填；cancelled 守卫防快速连切竞态
  useEffect(() => {
    let cancelled = false
    if (!currentConvId) {
      setActiveDraft('')
      draftTextRef.current = ''
      return
    }
    setActiveDraft('')
    draftTextRef.current = ''
    window.pocketai
      .getConversationDraft(currentConvId)
      .then((d) => { if (!cancelled) { setActiveDraft(d); draftTextRef.current = d } })
      .catch((e) => { if (!cancelled) reportIpcError('chat.getConversationDraft')(e) })
    return () => { cancelled = true }
  }, [currentConvId])

  // 关闭/卸载：取消待发防抖，尽力把最后一次击键落库（invoke 不 await；崩溃窗口仅 600ms）
  useEffect(() => {
    const flush = () => {
      if (draftTimerRef.current) {
        clearTimeout(draftTimerRef.current)
        draftTimerRef.current = undefined
        const id = currentConvRef.current
        if (id && draftTextRef.current.trim()) {
          void window.pocketai.setConversationDraft(id, draftTextRef.current).catch(() => {})
        }
      }
    }
    window.addEventListener('beforeunload', flush)
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('beforeunload', flush)
      window.removeEventListener('pagehide', flush)
    }
  }, [])

  /**
   * 切走前清理当前空壳会话：自动标题 + 未置顶 + 0 消息 + 0 草稿才删。
   * 草稿判断用渲染端同步镜像 draftTextRef（不查库），规避防抖窗口内 DB 尚无草稿的竞态；
   * SQL 端再叠四重守卫兜底。删除确认后本地同步列表，不 await、不阻塞跳转。
   */
  const discardCurrentIfEmpty = useCallback(() => {
    const id = currentConvRef.current
    if (!id) return
    if (messagesRef.current.length > 0) return
    if (draftTextRef.current.trim()) return
    const conv = convIndexRef.current.get(id)
    if (!conv || !conv.titleDefault || conv.pinned) return
    window.pocketai
      .deleteConversationIfEmpty(id)
      .then((r) => {
        if (!r.deleted) return
        setConversations((prev) => prev.filter((c) => c.id !== id))
        setArchivedConversations((prev) => prev.filter((c) => c.id !== id))
      })
      .catch(reportIpcError('chat.deleteConversationIfEmpty'))
  }, [])

  const handleSelectConv = (id: string) => {
    discardCurrentIfEmpty()
    userEditedTargetsRef.current = false // 切换会话时重置，允许回填
    setActiveDraft('') // 同步清空，防新会话草稿异步到达前闪现旧文本
    draftTextRef.current = ''
    setCurrentConvId(id)
    loadMessages(id)
    const conv = conversations.find((c) => c.id === id)
    if (conv) restoreLastModel(conv)
  }

  // 搜索跳转：切到目标会话并设 focusMessageId 让 ChatView 滚动+高亮
  const handleSelectMessage = useCallback((convId: string, messageId: string) => {
    discardCurrentIfEmpty()
    userEditedTargetsRef.current = false
    setActiveDraft('')
    draftTextRef.current = ''
    setCurrentConvId(convId)
    loadMessages(convId)
    setFocusMessageId(messageId)
  }, [loadMessages, discardCurrentIfEmpty])

  // 命令面板导航：跨助手先切助手+拉列表（不 autoSelect，防覆盖目标）再定位会话；
  // 仅助手项（无 conversationId）走标准助手切换自动选最近会话
  const handlePaletteOpen = useCallback((detail: OpenConversationDetail) => {
    if (detail.isAgent) return
    // 仅助手项：切助手（discard + reload autoSelect 最近会话 + 默认模型回填）
    if (!detail.conversationId) {
      if (detail.assistantId && detail.assistantId !== assistantIdRef.current) {
        discardCurrentIfEmpty()
        const asst = assistants.find((a) => a.id === detail.assistantId)
        assistantIdRef.current = detail.assistantId
        setCurrentAssistantId(detail.assistantId)
        setCurrentConvId(null)
        setMessages([])
        void reloadConversations(true)
        if (asst?.defaultProviderId && asst.defaultModel) {
          setTargets([{ providerId: asst.defaultProviderId, model: asst.defaultModel }]
          )
        }
      }
      return
    }
    const targetId = detail.conversationId
    const openWithin = (conv?: ConversationRecord) => {
      userEditedTargetsRef.current = false
      setActiveDraft('')
      draftTextRef.current = ''
      setCurrentConvId(targetId)
      void loadMessages(targetId)
      if (conv) restoreLastModel(conv)
    }
    if (detail.assistantId && detail.assistantId !== assistantIdRef.current) {
      discardCurrentIfEmpty()
      const asst = assistants.find((a) => a.id === detail.assistantId)
      assistantIdRef.current = detail.assistantId
      setCurrentAssistantId(detail.assistantId)
      setCurrentConvId(null)
      setMessages([])
      if (asst?.defaultProviderId && asst.defaultModel) {
        setTargets([{ providerId: asst.defaultProviderId, model: asst.defaultModel }])
      }
      void reloadConversations(false).then((list) => {
        // 事件路径与 pending 兜底竞态时清掉残留（助手此刻已匹配）
        consumePendingOpenConversation(false, detail.assistantId)
        openWithin(list.find((c) => c.id === targetId))
      })
    } else {
      discardCurrentIfEmpty()
      consumePendingOpenConversation(false, assistantIdRef.current)
      openWithin(conversations.find((c) => c.id === targetId))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistants, conversations, reloadConversations, loadMessages, restoreLastModel, discardCurrentIfEmpty])

  // 命令面板：挂载时消费 pending（面板从其他模块跳来，chat 可能尚未挂载；isAgent 不匹配保留）+ 常驻事件
  useEffect(() => {
    const pending = consumePendingOpenConversation(false, assistantIdRef.current)
    if (pending) handlePaletteOpen(pending)
    // 仅挂载首帧消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<OpenConversationDetail>).detail
      if (d && !d.isAgent) handlePaletteOpen(d)
    }
    window.addEventListener(OPEN_CONVERSATION_EVENT, handler)
    return () => window.removeEventListener(OPEN_CONVERSATION_EVENT, handler)
  }, [handlePaletteOpen])

  const handleNewConv = async () => {
    // 当前会话本身就是空壳（自动标题+未置顶+0消息；挂草稿的也一并复用，草稿随会话保留）
    // → 不新建行，避免点一次「新对话」堆一个空「新对话」
    const curId = currentConvId
    const cur = curId ? convIndexRef.current.get(curId) : null
    if (cur && cur.titleDefault && !cur.pinned && messagesRef.current.length === 0) {
      userEditedTargetsRef.current = false // 与新建同口径，允许模型回填
      setReplyToMessage(null)
      return
    }
    // 点击「新对话」直接在数据库创建一条对话记录，标题用当前助手名
    try {
      const title = currentAssistant?.name || t('chat.newConversation')
      const conv = await window.pocketai.createConversation(currentAssistantId, title)
      userEditedTargetsRef.current = false // 新对话允许模型回填
      setActiveDraft('')
      draftTextRef.current = ''
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

  // 用量排行点击跳转：消费 pending 参数，定位会话或切换助手
  useEffect(() => {
    const onUsageJump = () => {
      const d = consumePendingUsageJump()
      if (!d) return
      if (d.type === 'conversation') {
        // 明细行带 messageId：定位到会话内该条消息（滚动+高亮）
        if (d.messageId) handleSelectMessage(d.convId, d.messageId)
        else handleSelectConv(d.convId)
      } else if (d.type === 'assistant') {
        handleSelectAssistant(d.assistantId)
      }
    }
    window.addEventListener(USAGE_JUMP_EVENT, onUsageJump)
    return () => window.removeEventListener(USAGE_JUMP_EVENT, onUsageJump)
  }, [handleSelectConv, handleSelectAssistant, handleSelectMessage])

  // 用量预算启动提醒：今日/本月估算费用超预算时提示（进入聊天模块时检查一次）
  useEffect(() => {
    window.pocketai.getUsageBudget().then((b) => {
      if (b.daily !== null && b.daily > 0 && b.todayCost > b.daily) {
        toast.warning(t('usage.budgetExceeded', { scope: t('usage.budgetDaily') }))
      } else if (b.monthly !== null && b.monthly > 0 && b.monthCost > b.monthly) {
        toast.warning(t('usage.budgetExceeded', { scope: t('usage.budgetMonthly') }))
      }
    }).catch(() => { /* 预算状态不可达不阻断聊天 */ })
  }, [toast, t])

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

  const handleBatchDeleteConv = async (ids: string[]) => {
    try {
      const r = await window.pocketai.deleteConversations(ids)
      if (currentConvId && ids.includes(currentConvId)) {
        setCurrentConvId(null)
        setMessages([])
      }
      await reloadConversations()
      toast.success(t('chat.batchDeleteDone', { n: r.deleted }))
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
  // 消息跨会话转发：待转发的消息（弹窗选择目标会话/新会话）
  const [forwardSource, setForwardSource] = useState<MessageRecord | null>(null)
  const [forwarding, setForwarding] = useState(false)
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

  const handleSend = async (text: string, attachments?: ChatAttachment[], replyToId?: string | null, kbRefs?: string[]) => {
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
        attachments,
        replyToId: replyToId ?? null,
        kbRefs
      })
      .catch((e) => {
        failStream(requestId, convId)
        const msg = errText(e)
        // 预算硬阻断：识别 BUDGET_EXCEEDED:scope:limit 前缀，用专门文案
        const m = msg.match(/^BUDGET_EXCEEDED:(daily|monthly):([\d.]+):/)
        if (m) {
          const scope = m[1] === 'daily' ? t('usage.budgetDaily') : t('usage.budgetMonthly')
          toast.error(t('usage.budgetBlocked', { scope, limit: m[2]! }))
        }
      })
    setReplyToMessage(null)
  }

  // 引用回复：ChatView 已查好完整消息，直接设置
  const handleSetReply = (msg: MessageRecord | null) => {
    setReplyToMessage(msg)
  }

  // 收藏星标：IPC 落库 + 本地 messages 同步（不 reload，零闪烁）；收藏列表内取消收藏也走这里
  const handleToggleStar = useCallback(async (id: string, starred: boolean) => {
    try {
      await window.pocketai.setMessageStarred(id, starred)
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, starred } : m)))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }, [toast, t])

  /** 批量收藏/取消收藏：逐条落库后一次本地 map；部分失败仍同步已成功者 */
  const handleBatchToggleStar = useCallback(async (ids: string[], starred: boolean) => {
    const ok = new Set<string>()
    await Promise.all(ids.map(async (id) => {
      try { await window.pocketai.setMessageStarred(id, starred); ok.add(id) } catch { /* 单条失败静默跳过 */ }
    }))
    setMessages((prev) => prev.map((m) => (ok.has(m.id) ? { ...m, starred } : m)))
  }, [])

  // 消息置顶：IPC 落库 + 本地 messages 同步（不 reload，零闪烁）
  const handleToggleMessagePin = useCallback(async (id: string, pinned: boolean) => {
    try {
      await window.pocketai.setMessagePinned(id, pinned)
      setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, pinned } : m)))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }, [toast, t])

  /** 多选消息导出 Markdown：按会话内顺序过滤 → 构建 → 主进程另存为单文件；不清选择 */
  const handleExportMessages = useCallback(async (ids: string[]) => {
    const idSet = new Set(ids)
    const picked = messages.filter((m) => idSet.has(m.id))
    if (picked.length === 0) return
    const conv = conversations.find((c) => c.id === currentConvId)
    const assistantName = conv
      ? assistants.find((a) => a.id === conv.assistantId)?.name ?? null
      : null
    const title = conv?.title || 'PocketAI'
    const md = buildMessagesMarkdown({ title, assistantName }, picked)
    try {
      const r = await window.pocketai.exportMessages({
        defaultName: `${title}-${picked.length}`,
        content: md
      })
      if (r.canceled) return
      if (!r.ok) {
        toast.error(t('chat.exportFail', { e: r.error ?? t('common.unknownError') }))
        return
      }
      if (r.path) toast.success(t('chat.exportSuccess', { path: r.path }))
    } catch (e) {
      toast.error(t('chat.exportFail', { e: errText(e) }))
    }
  }, [messages, conversations, currentConvId, assistants, toast, t])

  /** 导出拖拽准备：与 handleExportMessages 同构构建 Markdown，写临时文件返回拖拽路径（不写则 null 退化） */
  const handlePrepareMessagesDrag = useCallback(async (ids: string[]): Promise<string | null> => {
    const idSet = new Set(ids)
    const picked = messages.filter((m) => idSet.has(m.id))
    if (picked.length === 0) return null
    const conv = conversations.find((c) => c.id === currentConvId)
    const assistantName = conv
      ? assistants.find((a) => a.id === conv.assistantId)?.name ?? null
      : null
    const title = conv?.title || 'PocketAI'
    const md = buildMessagesMarkdown({ title, assistantName }, picked)
    try {
      const r = await window.pocketai.prepareExportDrag({
        defaultName: `${title}-${picked.length}`,
        ext: 'md',
        content: md
      })
      return r.ok && r.path ? r.path : null
    } catch {
      return null
    }
  }, [messages, conversations, currentConvId, assistants])

  // ---------- 会话分组文件夹 ----------
  /** 本地 patch 会话分组归属（活跃+归档两列表） */
  const patchConvGroup = useCallback((convId: string, groupId: string | null) => {
    const patch = (list: ConversationRecord[]) =>
      list.some((c) => c.id === convId && c.groupId !== groupId)
        ? list.map((c) => (c.id === convId ? { ...c, groupId } : c))
        : list
    setConversations((prev) => patch(prev))
    setArchivedConversations((prev) => patch(prev))
  }, [])

  const handleCreateGroup = useCallback(async (name: string): Promise<boolean> => {
    try {
      const g = await window.pocketai.createConversationGroup(currentAssistantId, name)
      setGroups((prev) => [...prev, g])
      return true
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
      return false
    }
  }, [currentAssistantId, toast, t])

  const handleRenameGroup = useCallback(async (id: string, name: string) => {
    try {
      await window.pocketai.renameConversationGroup(id, name)
      setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, name } : g)))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }, [toast, t])

  /** 解散组：IPC 事务内解绑会话；本地同步移除组并把组内会话置回未分组 */
  const handleDeleteGroup = useCallback(async (id: string) => {
    try {
      await window.pocketai.deleteConversationGroup(id)
      setGroups((prev) => prev.filter((g) => g.id !== id))
      setConversations((prev) => prev.map((c) => (c.groupId === id ? { ...c, groupId: null } : c)))
      setArchivedConversations((prev) => prev.map((c) => (c.groupId === id ? { ...c, groupId: null } : c)))
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    }
  }, [toast, t])

  /** 移动会话到文件夹（null=移出）；乐观本地更新，失败回滚由 reload 兜底 */
  const handleMoveConv = useCallback(async (convId: string, groupId: string | null) => {
    patchConvGroup(convId, groupId)
    try {
      await window.pocketai.setConversationGroup(convId, groupId)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
      void reloadConversations()
    }
  }, [patchConvGroup, reloadConversations, toast, t])

  /** 设置会话备注（乐观本地更新两列表，失败回滚由 reload 兜底） */
  const handleSetNote = useCallback(async (convId: string, note: string | null) => {
    const patch = (list: ConversationRecord[]) =>
      list.map((c) => (c.id === convId ? { ...c, note } : c))
    setConversations((prev) => patch(prev))
    setArchivedConversations((prev) => patch(prev))
    try {
      await window.pocketai.setConversationNote(convId, note)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
      void reloadConversations()
    }
  }, [reloadConversations, toast, t])

  /** 设置会话级系统提示词覆盖（乐观本地更新，失败回滚由 reload 兜底） */
  const handleSetSystemPromptOverride = useCallback(async (convId: string, text: string | null) => {
    const patch = (list: ConversationRecord[]) =>
      list.map((c) => (c.id === convId ? { ...c, systemPromptOverride: text } : c))
    setConversations((prev) => patch(prev))
    setArchivedConversations((prev) => patch(prev))
    try {
      await window.pocketai.setConversationSystemPromptOverride(convId, text)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
      void reloadConversations()
    }
  }, [reloadConversations, toast, t])

  /** 转发消息：targetConvId=null 时主进程按源会话助手维度新建会话；成功后跳过去 */
  const handleForwardPick = useCallback(async (targetConvId: string | null) => {
    const src = forwardSource
    if (!src || forwarding) return
    setForwarding(true)
    try {
      const r = await window.pocketai.forwardMessage({
        targetConvId,
        sourceConvId: src.conversationId,
        role: src.role === 'assistant' ? 'assistant' : 'user',
        content: src.content,
        model: src.model ?? null
      })
      setForwardSource(null)
      toast.success(t('chat.forwarded'))
      await reloadConversations()
      handleSelectMessage(r.convId, r.messageId)
    } catch (e) {
      toast.error(t('common.opFailed', { msg: errText(e) }))
    } finally {
      setForwarding(false)
    }
  }, [forwardSource, forwarding, reloadConversations, handleSelectMessage, toast, t])

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
      const res = await window.pocketai.deleteMessagesBatch(ids)
      if (!res.ok) throw new Error('delete failed')
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

  // 助手配置导入导出：主进程负责文件对话框与落盘，此处只做结果提示与列表刷新
  const handleExportAssistants = useCallback(async () => {
    const r = await window.pocketai.exportAssistants()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if ('canceled' in r && r.canceled) return
    if ('count' in r) toast.success(t('rail.exportDone', { count: r.count }))
  }, [toast, t])

  const handleImportAssistants = useCallback(async () => {
    const r = await window.pocketai.importAssistants()
    if (!r.ok) {
      toast.error(r.error)
      return
    }
    if ('canceled' in r && r.canceled) return
    if ('imported' in r) {
      await reloadAssistants()
      toast.success(t('rail.importDone', { imported: r.imported, overwritten: r.overwritten, skipped: r.skipped }))
      if (r.droppedKb > 0 || r.droppedSkills > 0) {
        toast.error(t('rail.importDropped', { kb: r.droppedKb, skills: r.droppedSkills }))
      }
    }
  }, [reloadAssistants, toast, t])

  // 消息右键「提醒我」：正文截取 200 字，带会话 id 落库；到点由系统通知
  const handleRemind = useCallback(async (messageId: string, fireAt: number) => {
    const msg = messages.find((m) => m.id === messageId)
    const text = msg ? buildReminderText(msg.content ?? '') : ''
    if (!text) {
      toast.error(t('reminder.menu.emptyText'))
      return
    }
    try {
      await window.pocketai.createReminder({ text, fireAt, conversationId: currentConvId ?? null })
      toast.success(t('reminder.menu.created', { time: formatDateTime(fireAt) }))
    } catch (e) {
      toast.error(errText(e))
    }
  }, [messages, currentConvId, toast, t])

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
          onExport={() => void handleExportAssistants()}
          onImport={() => void handleImportAssistants()}
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
            onBatchDelete={handleBatchDeleteConv}
            onImport={handleImportConv}
            onImportEncrypted={handleImportEncrypted}
            onSelectMessage={handleSelectMessage}
            archivedConversations={archivedConversations}
            onTogglePin={handleTogglePin}
            onSetArchived={handleSetArchived}
            onToggleStar={handleToggleStar}
            groups={groups}
            onCreateGroup={handleCreateGroup}
            onRenameGroup={handleRenameGroup}
            onDeleteGroup={handleDeleteGroup}
            onMoveConv={handleMoveConv}
            onSetNote={handleSetNote}
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
        replyToMessage={replyToMessage}
        onReply={handleSetReply}
        onToggleStar={handleToggleStar}
        onBatchToggleStar={handleBatchToggleStar}
        onExportMessages={handleExportMessages}
        onPrepareMessagesDrag={handlePrepareMessagesDrag}
        onForward={setForwardSource}
        draftKey={currentConvId ?? ''}
        draft={activeDraft}
        onDraftChange={handleDraftChange}
        onDraftCommit={commitDraft}
        systemPromptOverride={conversations.find((c) => c.id === currentConvId)?.systemPromptOverride ?? null}
        onSetSystemPromptOverride={currentConvId ? (text) => handleSetSystemPromptOverride(currentConvId, text) : undefined}
        onRemind={handleRemind}
        onTogglePin={handleToggleMessagePin}
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

      {/* 消息转发弹窗：选择目标会话，或新建会话 */}
      {forwardSource && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setForwardSource(null)}>
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-96 max-h-[70vh] flex flex-col p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">{t('chat.forward')}</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-3 truncate" title={forwardSource.content}>
              {forwardSource.content.slice(0, 60)}
            </p>
            <button
              onClick={() => void handleForwardPick(null)}
              disabled={forwarding}
              className="w-full text-left px-3 py-2 mb-2 text-sm rounded border border-dashed border-[var(--color-border)] text-[var(--color-accent)] hover:bg-[var(--color-hover)] disabled:opacity-50"
            >
              ＋ {t('chat.forwardNew')}
            </button>
            <div className="flex-1 min-h-0 overflow-y-auto">
              {conversations.map((c) => (
                <button
                  key={c.id}
                  onClick={() => void handleForwardPick(c.id)}
                  disabled={forwarding}
                  className="w-full text-left px-3 py-2 text-sm rounded hover:bg-[var(--color-hover)] disabled:opacity-50 truncate"
                  title={c.title}
                >
                  {c.pinned ? '📌 ' : ''}{c.title}
                </button>
              ))}
            </div>
            <div className="flex justify-end mt-3">
              <button onClick={() => setForwardSource(null)} className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover)]">
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {dialog}
    </div>
  )
}
