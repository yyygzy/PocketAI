import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProviderRecord, MessageRecord, ChatTarget, ChatAttachment, AssistantRecord, UsagePricing } from '../../../../shared/types'
import { useI18n } from '../../i18n'
import { ModelSelector } from './ModelSelector'
import { MessageBubble } from './MessageBubble'
import { ComparisonColumns, type CompareColumn } from './ComparisonColumns'
import { BranchNav } from './BranchNav'
import { BranchCompare } from './BranchCompare'
import { Composer } from './Composer'
import { ChatConfigBar } from './ChatConfigBar'
import { writeClipboard } from '../../utils/clipboard'
import { useVirtualizer } from '@tanstack/react-virtual'
import { isNearBottom, shouldStickToBottom } from '../agent/components/virtual-list-utils'
import { sumMessagesUsage } from '../../utils/usage-summary'
import { fmtTokens, fmtCost } from '../../utils/token'
import { daySeparatorLabel, isDifferentDay, fileTimestamp } from '../../utils/time'
import { exportConversationAsPng } from '../../utils/export-image'
import { rangeBetween, mergeRange } from '../../utils/message-select'

interface Turn {
  user: MessageRecord | null
  replies: MessageRecord[]
  /** 按 batch 分组后的回复（每组 = 一次生成；多组即多分支） */
  batches: MessageRecord[][]
}

/** 一轮回复按批次分组：有 batchId 按 batchId 归组；旧数据按“连续 5 秒内”归为同批 */
function groupBatches(replies: MessageRecord[]): MessageRecord[][] {
  const batches: MessageRecord[][] = []
  let current: MessageRecord[] = []
  let currentBatchId: string | null | undefined = undefined
  for (const r of replies) {
    if (r.batchId) {
      if (r.batchId !== currentBatchId) {
        current = [r]
        batches.push(current)
        currentBatchId = r.batchId
      } else {
        current.push(r)
      }
    } else {
      const prev = current[current.length - 1]
      if (prev && !prev.batchId && r.createdAt - prev.createdAt <= 5000) {
        current.push(r)
      } else {
        current = [r]
        batches.push(current)
        currentBatchId = undefined
      }
    }
  }
  return batches
}

/**
 * 会话内搜索：返回 content 或附件文件名包含关键词（不区分大小写）的消息 id 列表，按消息原顺序。
 * 关键词 trim 后为空 → 空数组；纯前端实现，messages 已在内存。
 */
export function findMatchIds(messages: MessageRecord[], keyword: string): string[] {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return []
  const out: string[] = []
  for (const m of messages) {
    if (m.content && m.content.toLowerCase().includes(kw)) { out.push(m.id); continue }
    // 附件（图片/文本/知识库引用）按文件名参与检索，纯图片消息也可被搜到
    if (m.attachments?.some((a) => a.name.toLowerCase().includes(kw))) out.push(m.id)
  }
  return out
}

export interface FocusBranch {
  turnKey: string
  batchId: string
  nonce: number
}

interface Props {
  providers: ProviderRecord[]
  targets: ChatTarget[]
  onTargetsChange: (t: ChatTarget[]) => void
  messages: MessageRecord[]
  liveColumns: CompareColumn[] | null
  welcomeMessage?: string
  assistantName?: string
  assistant: AssistantRecord | null
  onAssistantUpdated: (a: AssistantRecord) => void
  onSend: (text: string, attachments?: ChatAttachment[]) => void
  onStop: () => void
  onRegenerate: (messageId: string) => void
  onResend: (messageId: string, newContent?: string) => void
  onDeleteMessage: (id: string) => void
  onDeleteMessages: (ids: string[]) => void
  onForkConversation?: (messageId: string) => void
  onSaveAsNote?: (messageId: string) => void
  /** 分支聚焦信号：生成完成后把指定轮次切到新分支 */
  focusBranch?: FocusBranch | null
  /** 搜索跳转定位：加载会话后滚动到匹配消息并临时高亮 */
  focusMessageId?: string | null
  /** 当前待回复的引用消息（Composer 显示引用条） */
  replyToMessage?: MessageRecord | null
  /** 设置/清除引用消息 */
  onReply?: (msg: MessageRecord | null) => void
  /** 切换消息收藏星标（IPC 落库由父级负责） */
  onToggleStar?: (id: string, starred: boolean) => void
  /** 批量收藏/取消收藏选中消息（starred=选中含任一未收藏时传 true，全已收藏时 false） */
  onBatchToggleStar?: (ids: string[], starred: boolean) => void
  /** 导出选中消息为 Markdown 单文件（另存对话框由主进程弹出） */
  onExportMessages?: (ids: string[]) => void
  /** 导出拖拽准备：pointerdown 预构建 Markdown 并写临时文件，返回拖拽用路径（失败/未就绪为 null） */
  onPrepareMessagesDrag?: (ids: string[]) => Promise<string | null>
  /** 转发消息到其他会话（弹窗由父级 ChatModule 负责） */
  onForward?: (msg: MessageRecord) => void
  /** 草稿归属会话 id（切换时 Composer 提交旧会话+回填新会话） */
  draftKey?: string
  /** 当前会话已保存草稿 */
  draft?: string
  /** 草稿文本变化（防抖落库；空串立即清除） */
  onDraftChange?: (text: string) => void
  /** 切会话时同步提交旧会话草稿 */
  onDraftCommit?: (convId: string, text: string) => void
  /** 本会话的系统提示词覆盖（NULL=使用助手默认） */
  systemPromptOverride?: string | null
  /** 设置/清除会话级系统提示词覆盖 */
  onSetSystemPromptOverride?: (text: string | null) => void
  /** 消息右键「提醒我」：父级按 id 取正文并调 IPC 建提醒 */
  onRemind?: (messageId: string, fireAt: number) => void
  /** 切换消息置顶（IPC 落库由父级负责） */
  onTogglePin?: (id: string, pinned: boolean) => void
}

export const ChatView: React.FC<Props> = ({
  providers,
  targets,
  onTargetsChange,
  messages,
  liveColumns,
  welcomeMessage,
  assistantName,
  assistant,
  onAssistantUpdated,
  onSend,
  onStop,
  onRegenerate,
  onResend,
  onDeleteMessage,
  onDeleteMessages,
  onForkConversation,
  onSaveAsNote,
  focusBranch,
  focusMessageId,
  replyToMessage,
  onReply,
  onToggleStar,
  onBatchToggleStar,
  onExportMessages,
  onPrepareMessagesDrag,
  onForward,
  draftKey,
  draft,
  onDraftChange,
  onDraftCommit,
  systemPromptOverride,
  onSetSystemPromptOverride,
  onRemind,
  onTogglePin
}) => {
  const { t } = useI18n()
  // 被引用消息快速查找表（用于气泡顶部显示引用条）
  const msgById = useMemo(() => {
    const m = new Map<string, MessageRecord>()
    for (const mm of messages) m.set(mm.id, mm)
    return m
  }, [messages])
  const replyPreview = (id: string | null | undefined): MessageRecord | null =>
    id ? msgById.get(id) ?? null : null
  // MessageBubble 传 messageId，这里查找完整消息后交父级设置引用状态
  const handleReply = useCallback((id: string) => {
    const m = msgById.get(id)
    if (m) onReply?.(m)
  }, [msgById, onReply])
  // 转发同理：MessageBubble 只持有 messageId，查全量记录后交父级弹窗
  const handleForward = useCallback((id: string) => {
    const m = msgById.get(id)
    if (m) onForward?.(m)
  }, [msgById, onForward])
  const scrollBoxRef = useRef<HTMLDivElement>(null)
  const streaming = liveColumns !== null
  // 用户是否处于底部锚定区（历史状态，scroll 事件更新，避免竞态抖动）
  const isAtBottomRef = useRef(true)
  // 切会话后待滚底标记：messages 异步加载，length 变化 effect 里消费
  const pendingScrollBottomRef = useRef(true)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  /** Shift 范围连选的锚点（最后一次普通点击的消息 id）；切会话清空 */
  const lastAnchorRef = useRef<string | null>(null)
  /** 各轮次手动选中的分支（turnKey → batchKey）；无条目时显示最新分支 */
  const [activeBranchMap, setActiveBranchMap] = useState<Record<string, string>>({})
  /** 处于并排对比模式的轮次（turnKey 集合） */
  const [compareTurns, setCompareTurns] = useState<Set<string>>(new Set())
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null)
  /** 长会话滚动超过阈值时显示「回到顶部」按钮 */
  const [showJumpTop, setShowJumpTop] = useState(false)
  /** 当前是否在底部（state 驱动回底按钮显隐，与 isAtBottomRef 同步） */
  const [atBottom, setAtBottom] = useState(true)
  /** 导出长图进行中（防重复点击） */
  const [exportingImage, setExportingImage] = useState(false)
  /** 长图拖拽缓存：上次导出的 dataUrl + 文件名（messages 引用变化即失效） */
  const pngCacheRef = useRef<{ dataUrl: string; fileName: string; messagesRef: MessageRecord[] } | null>(null)
  /** 拖拽临时文件路径（pointerdown 预写入，dragstart 同步消费；null=未就绪） */
  const dragPathRef = useRef<string | null>(null)
  /** 系统提示词覆盖弹层开关 */
  const [sysOverrideOpen, setSysOverrideOpen] = useState(false)
  const [sysOverrideText, setSysOverrideText] = useState('')
  // 会话内搜索：开关/关键词/当前命中下标
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [curMatchIdx, setCurMatchIdx] = useState(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  /** 本机单价配置：气泡 token 微展示命中单价时附带估算费用；拉取失败静默只显示 token */
  const [pricing, setPricing] = useState<UsagePricing | null>(null)
  useEffect(() => {
    window.pocketai.getUsagePricing().then(setPricing).catch(() => {})
  }, [])

  // 分支聚焦：重新生成/编辑重发完成后自动切到新分支
  // 父组件每次 setFocusBranch 都自增 nonce，引用变即 nonce 变；直接依赖 focusBranch
  // 消除 lint 警告，避免读 turnKey/batchId 时的 stale closure 风险
  useEffect(() => {
    if (focusBranch) {
      setActiveBranchMap((prev) => ({ ...prev, [focusBranch.turnKey]: focusBranch.batchId }))
    }
  }, [focusBranch])

  // 切换会话（首条消息 id 变化）时清空选择并设待滚底标记
  const firstMsgId = messages[0]?.id ?? null
  useEffect(() => {
    setSelectedIds(new Set())
    lastAnchorRef.current = null
    pendingScrollBottomRef.current = true
    isAtBottomRef.current = true
  }, [firstMsgId])

  /** 可选择消息的有序 id（仅 user/assistant，与全选/范围选择同口径） */
  const selectableIds = useMemo(
    () => messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.id),
    [messages]
  )

  const toggleSelect = useCallback((id: string, range = false) => {
    if (range && lastAnchorRef.current) {
      // Shift+点击：锚点到目标整段并入（区间外既有选择保留，锚点不变可连续扩展）
      const span = rangeBetween(selectableIds, lastAnchorRef.current, id)
      setSelectedIds((prev) => mergeRange(prev, span))
      return
    }
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    lastAnchorRef.current = id
  }, [selectableIds])

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(selectableIds))
    lastAnchorRef.current = selectableIds[0] ?? null
  }, [selectableIds])

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set())
    lastAnchorRef.current = null
  }, [])

  const handleCopySelected = useCallback(() => {
    const selected = messages.filter((m) => selectedIds.has(m.id))
    const text = selected
      .map((m) => `${m.role === 'user' ? t('chatview.roleUser') : t('chatview.roleAssistant')}: ${m.content}`)
      .join('\n\n')
    // 含 textarea 降级；无反馈 UI，失败静默
    void writeClipboard(text)
  }, [messages, selectedIds, t])

  const handleDeleteSelected = useCallback(() => {
    if (selectedIds.size === 0) return
    onDeleteMessages(Array.from(selectedIds))
    setSelectedIds(new Set())
  }, [selectedIds, onDeleteMessages])

  /**
   * 批量星标：选中中存在任一条未收藏 → 全部收藏；全部已收藏 → 全部取消。
   * 完成后清空选择。
   */
  const selectedList = messages.filter((m) => selectedIds.has(m.id))
  const allSelectedStarred = selectedList.length > 0 && selectedList.every((m) => m.starred)
  const handleBatchStar = useCallback(() => {
    if (selectedIds.size === 0) return
    onBatchToggleStar?.(Array.from(selectedIds), !allSelectedStarred)
    setSelectedIds(new Set())
  }, [selectedIds, allSelectedStarred, onBatchToggleStar])

  const handleDeleteOne = useCallback((id: string) => {
    onDeleteMessage(id)
    setSelectedIds((prev) => {
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [onDeleteMessage])

  // 扁平消息 → 轮次分组（回复按 batch 分组为分支）
  const turns = useMemo<Turn[]>(() => {
    const result: Turn[] = []
    for (const m of messages) {
      if (m.role === 'user') {
        result.push({ user: m, replies: [], batches: [] })
      } else if (m.role === 'assistant') {
        const last = result[result.length - 1]
        if (last) last.replies.push(m)
        else result.push({ user: null, replies: [m], batches: [] })
      }
    }
    for (const t of result) t.batches = groupBatches(t.replies)
    return result
  }, [messages])

  // 实时流作为虚拟批次挂到最后一轮（新发送：唯一批次；分支重跑：追加为最新批次）
  const renderedTurns: Turn[] = useMemo(() => {
    if (!liveColumns) return turns
    const virtualReplies: MessageRecord[] = liveColumns.map((c, i) => ({
      id: `live-${i}`,
      conversationId: '',
      role: 'assistant',
      content: c.content,
      provider: c.providerId,
      model: c.model,
      status: c.status,
      parentId: null,
      createdAt: Date.now()
    }))
    const copy = turns.map((t) => ({ ...t, batches: [...t.batches] }))
    const last = copy[copy.length - 1]
    if (last && last.user && last.replies.length === 0) {
      last.batches = [virtualReplies]
    } else if (last) {
      last.batches = [...last.batches, virtualReplies]
    } else {
      copy.push({ user: null, replies: virtualReplies, batches: [virtualReplies] })
    }
    return copy
  }, [turns, liveColumns])

  // 虚拟化：每轮一个虚拟项，只渲染可视区 + overscan，避免长对话 DOM 线性增长
  // 复用 V3-Eng-2 模式：measureElement 动态高度 + isNearBottom/shouldStickToBottom 滚底决策
  const virtualizer = useVirtualizer({
    count: renderedTurns.length,
    getScrollElement: () => scrollBoxRef.current,
    estimateSize: () => 200,
    overscan: 4,
    measureElement: (el) => {
      return el instanceof HTMLElement ? el.getBoundingClientRect().height : 200
    }
  })

  // 搜索跳转定位：messages 加载后找到匹配消息所在 turn，滚到居中 + 临时高亮 2s
  useEffect(() => {
    if (!focusMessageId || messages.length === 0) return
    const idx = renderedTurns.findIndex(
      (t) => t.user?.id === focusMessageId || t.replies.some((r) => r.id === focusMessageId)
    )
    if (idx < 0) return
    virtualizer.scrollToIndex(idx, { align: 'center' })
    setHighlightMsgId(focusMessageId)
    const timer = setTimeout(() => setHighlightMsgId(null), 2000)
    return () => clearTimeout(timer)
  }, [focusMessageId, messages, renderedTurns, virtualizer])

  /** 置顶横幅展开态（默认最多展示 3 条，超出折叠） */
  const [pinsExpanded, setPinsExpanded] = useState(false)
  /** 置顶列表从 messages 派生（与星标同源，本地 map 更新即同步） */
  const pinnedList = useMemo(() => messages.filter((m) => m.pinned), [messages])
  /** 置顶横幅点击定位：与搜索跳转同口径（滚动居中 + 高亮 2s） */
  const jumpToPinned = useCallback(
    (id: string) => {
      const idx = renderedTurns.findIndex(
        (t) => t.user?.id === id || t.replies.some((r) => r.id === id)
      )
      if (idx < 0) return
      virtualizer.scrollToIndex(idx, { align: 'center' })
      setHighlightMsgId(id)
      setTimeout(() => setHighlightMsgId(null), 2000)
    },
    [renderedTurns, virtualizer]
  )

  /** 批次标识：有 batchId 用 batchId，旧数据退化为下标 */
  const batchKeyOf = (batch: MessageRecord[], idx: number): string => batch[0]?.batchId ?? `legacy:${idx}`

  /** 某轮当前显示的批次下标：优先手动选择，否则最新批次 */
  const activeBatchIndexOf = (turn: Turn, turnKey: string): number => {
    if (turn.batches.length <= 1) return 0
    const want = activeBranchMap[turnKey]
    if (want) {
      const idx = turn.batches.findIndex((b, i) => batchKeyOf(b, i) === want)
      if (idx >= 0) return idx
    }
    return turn.batches.length - 1
  }

  const switchBranch = (turn: Turn, turnKey: string, dir: -1 | 1): void => {
    const cur = activeBatchIndexOf(turn, turnKey)
    const next = cur + dir
    if (next < 0 || next >= turn.batches.length) return
    const key = batchKeyOf(turn.batches[next]!, next)
    setActiveBranchMap((prev) => ({ ...prev, [turnKey]: key }))
  }

  const toggleCompare = (turnKey: string): void => {
    setCompareTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnKey)) next.delete(turnKey)
      else next.add(turnKey)
      return next
    })
  }

  /** 对比模式点「设为当前」：切激活分支并退出该轮对比 */
  const activateBranch = (turnKey: string, batchKey: string): void => {
    setActiveBranchMap((prev) => ({ ...prev, [turnKey]: batchKey }))
    setCompareTurns((prev) => {
      const next = new Set(prev)
      next.delete(turnKey)
      return next
    })
  }

  // 滚底决策：切会话待滚底标记优先；否则流式追加时按 isAtBottomRef 跟滚
  useEffect(() => {
    const count = renderedTurns.length
    if (count === 0) return
    const lastIndex = count - 1
    if (pendingScrollBottomRef.current) {
      virtualizer.scrollToIndex(lastIndex, { align: 'end' })
      pendingScrollBottomRef.current = false
      isAtBottomRef.current = true
      return
    }
    if (shouldStickToBottom(false, isAtBottomRef.current, streaming)) {
      virtualizer.scrollToIndex(lastIndex, { align: 'end' })
    }
  }, [renderedTurns.length, liveColumns, streaming, virtualizer])

  const handleScroll = useCallback(() => {
    const el = scrollBoxRef.current
    if (!el) return
    const near = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight, 48)
    isAtBottomRef.current = near
    setAtBottom(near)
    setShowJumpTop(el.scrollTop > 300)
  }, [])

  const canSend = targets.length > 0 && targets.every((t) => t.providerId && t.model)

  /** 回到底部：滚到最后一轮并标记在底部（恢复流式跟滚） */
  const jumpToBottom = useCallback(() => {
    if (renderedTurns.length === 0) return
    virtualizer.scrollToIndex(renderedTurns.length - 1, { align: 'end' })
    isAtBottomRef.current = true
    setAtBottom(true)
  }, [renderedTurns.length, virtualizer])

  /** 回到首条消息 */
  const jumpToTop = useCallback(() => {
    virtualizer.scrollToIndex(0, { align: 'start' })
  }, [virtualizer])

  /**
   * 导出当前会话为 PNG 长图：
   * 把完整 messages 临时渲染到离屏容器（绕过虚拟化，保证 DOM 完整），
   * 用 html-to-image 截图后触发下载，完成即卸载离屏容器。
   * 超过 500 条仅导出最近 500 条（防 OOM）。
   */
  const handleExportImage = useCallback(async () => {
    if (exportingImage || messages.length === 0) return
    const LIMIT = 500
    const slice = messages.length > LIMIT ? messages.slice(-LIMIT) : messages
    setExportingImage(true)
    try {
      const fileName = `pocketai-${fileTimestamp(Date.now())}.png`
      const dataUrl = await exportConversationAsPng({
        messages: slice,
        truncated: messages.length > LIMIT,
        assistantName: assistantName ?? null,
        fileName,
        t
      })
      // 缓存供导出拖拽复用（messages 引用变化即视为失效）
      pngCacheRef.current = { dataUrl, fileName, messagesRef: messages }
    } catch (e) {
      console.error('export image failed', e)
    } finally {
      setExportingImage(false)
    }
  }, [exportingImage, messages, assistantName, t])

  /** 多选导出长图：复用同一渲染管线，按 selectedIds 顺序过滤 */
  const handleExportSelectedImage = useCallback(async () => {
    if (exportingImage || selectedIds.size === 0) return
    const orderedIds = Array.from(selectedIds)
    const slice: MessageRecord[] = []
    for (const m of messages) {
      if (orderedIds.includes(m.id)) slice.push(m)
    }
    const LIMIT = 500
    const truncated = slice.length > LIMIT
    const finalSlice = truncated ? slice.slice(0, LIMIT) : slice
    setExportingImage(true)
    try {
      const fileName = `pocketai-selected-${fileTimestamp(Date.now())}.png`
      await exportConversationAsPng({
        messages: finalSlice,
        truncated,
        assistantName: assistantName ?? null,
        fileName,
        t
      })
    } catch (e) {
      console.error('export selected image failed', e)
    } finally {
      setExportingImage(false)
    }
  }, [exportingImage, selectedIds, messages, assistantName, t])

  /** 长图按钮 pointerdown：有 PNG 缓存时预写拖拽临时文件（无缓存则本次不可拖，退化为点击导出） */
  const handleImageDragPointerDown = useCallback(() => {
    dragPathRef.current = null
    const cache = pngCacheRef.current
    if (!cache || cache.messagesRef !== messages) return
    const base64 = cache.dataUrl.split(',')[1] ?? ''
    if (!base64) return
    void window.pocketai.prepareExportDrag({ defaultName: cache.fileName, ext: 'png', content: base64 })
      .then((r) => { if (r.ok && r.path) dragPathRef.current = r.path })
      .catch(() => {})
  }, [messages])

  /** dragstart 同步消费预写路径；未就绪（预写未完成/失败）则取消本次拖拽，不影响点击导出 */
  const handleExportDragStart = useCallback((e: React.DragEvent) => {
    const p = dragPathRef.current
    if (!p) {
      e.preventDefault()
      return
    }
    window.pocketai.startExportDrag(p)
  }, [])

  /** 多选导出按钮 pointerdown：预构建 Markdown 写临时文件（内容轻量，pointerdown→dragstart 间隙足够） */
  const handleMessagesDragPointerDown = useCallback(() => {
    dragPathRef.current = null
    if (!onPrepareMessagesDrag) return
    void onPrepareMessagesDrag(Array.from(selectedIds))
      .then((p) => { dragPathRef.current = p })
      .catch(() => {})
  }, [onPrepareMessagesDrag, selectedIds])

  // 会话内搜索命中列表（按消息顺序）
  const matchIds = useMemo(() => findMatchIds(messages, searchKeyword), [messages, searchKeyword])

  // 关键词变化时重置到第一个命中
  useEffect(() => {
    setCurMatchIdx(0)
  }, [searchKeyword])

  // 跳转到第 dir 个命中（dir=1 下一个，-1 上一个，循环）
  const gotoMatch = useCallback(
    (dir: 1 | -1) => {
      if (matchIds.length === 0) return
      setCurMatchIdx((prev) => {
        const next = (prev + dir + matchIds.length) % matchIds.length
        const mid = matchIds[next]
        if (!mid) return prev
        const idx = renderedTurns.findIndex(
          (t) => t.user?.id === mid || t.replies.some((r) => r.id === mid)
        )
        if (idx >= 0) {
          virtualizer.scrollToIndex(idx, { align: 'center' })
          setHighlightMsgId(mid)
          setTimeout(() => setHighlightMsgId(null), 2000)
        }
        return next
      })
    },
    [matchIds, renderedTurns, virtualizer]
  )

  // 点击引用条：跳转到被引用消息并临时高亮
  const onJumpToReply = useCallback((targetId: string) => {
    const idx = renderedTurns.findIndex(
      (t) => t.user?.id === targetId || t.replies.some((r) => r.id === targetId)
    )
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' })
      setHighlightMsgId(targetId)
      setTimeout(() => setHighlightMsgId(null), 2000)
    }
  }, [renderedTurns, virtualizer])

  // 打开搜索并聚焦输入框
  const openSearch = useCallback(() => {
    setSearchOpen(true)
    setTimeout(() => searchInputRef.current?.focus(), 0)
  }, [])

  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    setSearchKeyword('')
    setCurMatchIdx(0)
  }, [])

  // 搜索快捷键：Ctrl/Cmd+F 打开；打开后 Enter 下一个 / Shift+Enter 上一个 / Esc 关闭
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        openSearch()
        return
      }
      if (!searchOpen) return
      if (e.key === 'Escape') {
        e.preventDefault()
        closeSearch()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        gotoMatch(e.shiftKey ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [searchOpen, openSearch, closeSearch, gotoMatch])

  // 本会话累计用量（账单口径：含分支重跑全部批次；旧消息无 usage 自然不计）
  const sessionUsage = useMemo(() => sumMessagesUsage(messages, pricing), [messages, pricing])
  const currencySymbol = pricing?.currency === 'USD' ? '$' : '¥'
  const sessionCostText = fmtCost(sessionUsage.cost)
  const sessionUsageHint = [
    t('chatview.tokenHint', {
      prompt: sessionUsage.promptTokens,
      completion: sessionUsage.completionTokens
    }),
    sessionUsage.cachedTokens > 0
      ? t('chatview.tokenCachedHint', { cached: sessionUsage.cachedTokens })
      : '',
    sessionCostText ? `${currencySymbol}${sessionCostText}` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* 顶部模型选择栏 */}
      <div className="shrink-0 min-h-12 flex items-center px-4 border-b border-[var(--color-border)] py-1.5">
        <ModelSelector
          providers={providers}
          targets={targets}
          onChange={onTargetsChange}
          disabled={streaming}
        />
        <button
          onClick={openSearch}
          className="ml-auto p-1.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
          title={t('chatview.searchInConversation')}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
        </button>
        {/* 系统提示词覆盖：会话级临时覆盖助手全局提示词 */}
        {onSetSystemPromptOverride && (
          <button
            onClick={() => { setSysOverrideText(systemPromptOverride ?? ''); setSysOverrideOpen(true) }}
            className="ml-1 p-1.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
            title={t('chat.sysOverride.button')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </button>
        )}
        <button
          onClick={() => void handleExportImage()}
          draggable
          onPointerDown={handleImageDragPointerDown}
          onDragStart={handleExportDragStart}
          disabled={exportingImage || messages.length === 0}
          className="ml-1 p-1.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors disabled:opacity-40"
          title={exportingImage ? t('chat.exportingImage') : t('chat.exportImageDrag')}
        >
          {exportingImage ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
          )}
        </button>
      </div>

      {/* 会话内搜索条 */}
      {searchOpen && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-hover-overlay)]">
          <input
            ref={searchInputRef}
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            placeholder={t('chatview.searchPlaceholder')}
            className="flex-1 min-w-0 px-2 py-1 text-sm rounded border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text)] outline-none focus:border-[var(--color-accent)]"
          />
          <span className="text-xs text-[var(--color-text-muted)] whitespace-nowrap tabular-nums">
            {matchIds.length === 0 ? '0/0' : `${curMatchIdx + 1}/${matchIds.length}`}
          </span>
          <button
            onClick={() => gotoMatch(-1)}
            disabled={matchIds.length === 0}
            className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-sidebar)] disabled:opacity-30"
            title={t('chatview.searchPrev')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <button
            onClick={() => gotoMatch(1)}
            disabled={matchIds.length === 0}
            className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-sidebar)] disabled:opacity-30"
            title={t('chatview.searchNext')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <button
            onClick={closeSearch}
            className="p-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-sidebar)]"
            title={t('common.close')}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* 置顶横幅：会话内钉住的关键消息（固定不随滚动，最多 3 条超出折叠） */}
      {pinnedList && pinnedList.length > 0 && (
        <div className="shrink-0 border-b border-[var(--color-border)] bg-[var(--color-sidebar)] px-4 py-1.5">
          <div className="max-w-5xl mx-auto flex flex-col gap-1">
            {(pinsExpanded ? pinnedList : pinnedList.slice(0, 3)).map((m) => (
              <div key={m.id} className="flex items-center gap-2 text-[11px] group/pin">
                <button
                  onClick={() => jumpToPinned(m.id)}
                  className="flex-1 min-w-0 text-left flex items-center gap-1.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
                  title={m.content}
                >
                  <span className="shrink-0">📌</span>
                  <span className="shrink-0">{m.role === 'user' ? t('chat.you') : t('chat.assistant')}:</span>
                  <span className="truncate">{m.content.replace(/\s+/g, ' ').slice(0, 80)}</span>
                </button>
                <button
                  onClick={() => onTogglePin?.(m.id, false)}
                  title={t('chat.unpin')}
                  aria-label={t('chat.unpin')}
                  className="shrink-0 opacity-0 group-hover/pin:opacity-100 text-[var(--color-text-muted)] hover:text-[var(--color-danger)] transition-opacity"
                >
                  ✕
                </button>
              </div>
            ))}
            {!pinsExpanded && pinnedList.length > 3 && (
              <button
                onClick={() => setPinsExpanded(true)}
                className="self-start text-[11px] text-[var(--color-text-muted)] hover:text-[var(--color-accent)] transition-colors"
              >
                {t('chat.morePinned', { n: pinnedList.length - 3 })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* 批量操作栏（选中消息时显示） */}
      {selectedIds.size > 0 && (
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-[var(--color-border)] bg-[var(--color-hover-overlay)]">
          <span className="text-xs text-[var(--color-text-muted)]">
            {t('chatview.selectedCount', { n: selectedIds.size })}
          </span>
          <button
            onClick={selectAll}
            className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors"
          >
            {t('common.selectAll')}
          </button>
          <button
            onClick={handleCopySelected}
            className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors"
          >
            {t('common.copySelected')}
          </button>
          {onExportMessages && (
            <button
              onClick={() => onExportMessages(Array.from(selectedIds))}
              draggable={!!onPrepareMessagesDrag}
              onPointerDown={handleMessagesDragPointerDown}
              onDragStart={handleExportDragStart}
              title={t('chatview.exportSelectedDrag')}
              className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors"
            >
              {t('chatview.exportSelected')}
            </button>
          )}
          <button
            onClick={() => void handleExportSelectedImage()}
            disabled={exportingImage}
            title={t('chat.exportImageDrag')}
            className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors disabled:opacity-50"
          >
            {t('chatview.exportSelectedImage')}
          </button>
          {onBatchToggleStar && (
            <button
              onClick={handleBatchStar}
              className="text-xs px-2 py-1 rounded text-[var(--color-text)] hover:bg-[var(--color-sidebar)] transition-colors"
            >
              {allSelectedStarred ? t('common.unstarSelected') : t('common.starSelected')}
            </button>
          )}
          <button
            onClick={handleDeleteSelected}
            className="text-xs px-2 py-1 rounded text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] transition-colors"
          >
            {t('common.deleteSelected')}
          </button>
          <button
            onClick={clearSelection}
            className="text-xs px-2 py-1 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-sidebar)] transition-colors ml-auto"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {/* 消息流（虚拟化：每轮一个虚拟项，只渲染可视区 + overscan） */}
      <div ref={scrollBoxRef} onScroll={handleScroll} className="flex-1 overflow-y-auto relative">
        <div className="max-w-5xl mx-auto px-4 py-5">
          {/* 本会话累计用量条（随消息流滚动，hover 看输入/输出/缓存明细） */}
          {renderedTurns.length > 0 && sessionUsage.totalTokens > 0 && (
            <div
              title={sessionUsageHint}
              className="flex justify-end mb-3 text-[11px] text-[var(--color-text-muted)] font-mono cursor-default"
            >
              <span className="px-2 py-0.5 rounded-full bg-[var(--color-hover-overlay)]">
                {t('chatview.sessionUsage', { tokens: fmtTokens(sessionUsage.totalTokens) })}
                {sessionCostText && (
                  <span className="ml-1.5 text-[var(--color-accent)]">
                    {currencySymbol}
                    {sessionCostText}
                  </span>
                )}
              </span>
            </div>
          )}
          {renderedTurns.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-72 text-center px-6">
              <div className="text-4xl mb-3">🎒</div>
              {assistantName && <p className="text-[var(--color-text)] font-semibold">{assistantName}</p>}
              {welcomeMessage ? (
                <p className="text-sm text-[var(--color-text-muted)] mt-2 max-w-md leading-relaxed whitespace-pre-wrap">
                  {welcomeMessage}
                </p>
              ) : (
                <p className="text-sm text-[var(--color-text-muted)] mt-2">{t('chatview.start')}</p>
              )}
              <p className="text-[11px] text-[var(--color-text-muted)] mt-3">
                {t('chatview.hint')}
              </p>
            </div>
          ) : (
            <div style={{ position: 'relative', height: virtualizer.getTotalSize(), width: '100%' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const turn = renderedTurns[vi.index]
                if (!turn) return null
                const ti = vi.index
                const turnKey = turn.user?.id ?? `turn-${ti}`
                const activeIdx = activeBatchIndexOf(turn, turnKey)
                const activeBatch = turn.batches[activeIdx] ?? []
                const msg = activeBatch[0]! // length === 1 分支内必非空
                const label = activeBatch
                  .map((r) => r.model)
                  .filter(Boolean)
                  .join(' · ')
                const comparing = compareTurns.has(turnKey) && turn.batches.length > 1
                // 该轮时间戳：用户消息优先，否则取该轮首条回复
                const turnTs = turn.user?.createdAt ?? turn.replies[0]?.createdAt
                // 日期分隔线：与上一轮不同自然日时在轮顶插入
                const prev = ti > 0 ? renderedTurns[ti - 1] : null
                const prevTs = prev ? (prev.user?.createdAt ?? prev.replies[0]?.createdAt) : null
                const showDateSep = !!turnTs && (!prevTs || isDifferentDay(turnTs, prevTs))
                return (
                  <div
                    key={turn.user?.id ?? `turn-${ti}`}
                    data-index={vi.index}
                    ref={virtualizer.measureElement}
                    className="space-y-4"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      transform: `translateY(${vi.start}px)`,
                      width: '100%',
                      // pb-6 模拟原 space-y-6 轮次间距（absolute 元素 margin 不生效，用 padding 计入测量高度）
                      paddingBottom: 24
                    }}
                  >
                    {showDateSep && turnTs && (
                      <div className="flex items-center gap-2 my-1">
                        <div className="flex-1 h-px bg-[var(--color-border)]" />
                        <span className="text-[11px] text-[var(--color-text-muted)] whitespace-nowrap">
                          {daySeparatorLabel(turnTs, t)}
                        </span>
                        <div className="flex-1 h-px bg-[var(--color-border)]" />
                      </div>
                    )}
                    {turn.user && (
                      <MessageBubble
                        role="user"
                        content={turn.user.content}
                        messageId={turn.user.id}
                        createdAt={turn.user.createdAt}
                        attachments={turn.user.attachments}
                        replyTo={replyPreview(turn.user.replyToId)}
                        onJumpToReply={onJumpToReply}
                        selected={selectedIds.has(turn.user.id)}
                        highlight={highlightMsgId === turn.user.id}
                        onToggleSelect={toggleSelect}
                        onDelete={handleDeleteOne}
                        onResend={onResend}
                        onFork={onForkConversation}
                        onSaveAsNote={onSaveAsNote}
                        onReply={handleReply}
                        onForward={handleForward}
                        starred={turn.user.starred}
                        onToggleStar={onToggleStar}
                        pinned={turn.user.pinned}
                        onTogglePin={onTogglePin}
                        selectMode={selectedIds.size > 0}
                        onRemind={onRemind}
                      />
                    )}
                    {comparing ? (
                      <BranchCompare
                        batches={turn.batches}
                        activeIndex={activeIdx}
                        onActivate={(bi) => activateBranch(turnKey, batchKeyOf(turn.batches[bi]!, bi))}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                        onDelete={handleDeleteOne}
                        pricing={pricing}
                      />
                    ) : activeBatch.length === 1 ? (
                      <MessageBubble
                        role="assistant"
                        content={msg.content}
                        model={msg.model}
                        streaming={msg.status === 'streaming'}
                        messageId={msg.id}
                        createdAt={msg.createdAt}
                        sources={msg.sources ?? undefined}
                        usage={msg.usage ?? null}
                        provider={msg.provider ?? null}
                        pricing={pricing}
                        replyTo={replyPreview(msg.replyToId)}
                        onJumpToReply={onJumpToReply}
                        selected={selectedIds.has(msg.id)}
                        highlight={highlightMsgId === msg.id}
                        onToggleSelect={toggleSelect}
                        onDelete={handleDeleteOne}
                        onRegenerate={onRegenerate}
                        onFork={onForkConversation}
                        onSaveAsNote={onSaveAsNote}
                        onReply={handleReply}
                        onForward={handleForward}
                        starred={msg.starred}
                        onToggleStar={onToggleStar}
                        pinned={msg.pinned}
                        onTogglePin={onTogglePin}
                        selectMode={selectedIds.size > 0}
                        onRemind={onRemind}
                      />
                    ) : activeBatch.length > 1 ? (
                      <ComparisonColumns
                        providers={providers}
                        columns={activeBatch.map((r) => ({
                          providerId: r.provider ?? '',
                          model: r.model ?? '',
                          content: r.content,
                          status: r.status === 'streaming' ? 'streaming' : r.status === 'error' ? 'error' : r.status === 'aborted' ? 'aborted' : 'done'
                        }))}
                        messageIds={activeBatch.map((r) => r.id)}
                        selectedIds={selectedIds}
                        onToggleSelect={toggleSelect}
                        onDelete={handleDeleteOne}
                      />
                    ) : null}
                    {turn.batches.length > 1 && (
                      <BranchNav
                        index={activeIdx}
                        total={turn.batches.length}
                        label={label}
                        comparing={comparing}
                        onToggleCompare={() => toggleCompare(turnKey)}
                        onPrev={() => switchBranch(turn, turnKey, -1)}
                        onNext={() => switchBranch(turn, turnKey, 1)}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {/* 浮动跳转按钮：回到底部（非底部时）/ 回到顶部（滚动超 300px 时） */}
        {(showJumpTop || !atBottom) && renderedTurns.length > 0 && (
          <div className="absolute right-4 bottom-4 flex flex-col gap-2 z-20">
            {showJumpTop && (
              <button
                onClick={jumpToTop}
                title={t('chat.jumpToTop')}
                className="w-9 h-9 rounded-full bg-[var(--color-sidebar)] border border-[var(--color-border)] shadow-md flex items-center justify-center text-[var(--color-text-muted)] hover:text-[var(--color-accent)] hover:border-[var(--color-accent)] transition-colors"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 15-6-6-6 6"/></svg>
              </button>
            )}
            {!isAtBottomRef.current && (
              <button
                onClick={jumpToBottom}
                title={t('chat.jumpToBottom')}
                className="w-9 h-9 rounded-full bg-[var(--color-accent)] text-[var(--color-on-accent)] shadow-md flex items-center justify-center hover:opacity-90 transition-opacity"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
            )}
          </div>
        )}
      </div>

      <Composer
        streaming={streaming}
        canSend={canSend}
        onSend={onSend}
        onStop={onStop}
        replyTo={replyToMessage ?? null}
        onCancelReply={() => onReply?.(null)}
        draftKey={draftKey ?? ''}
        draft={draft}
        onDraftChange={onDraftChange}
        onDraftCommit={onDraftCommit}
        messages={messages}
      />

      {/* 系统提示词覆盖弹层：textarea 预填当前 override，无 override 时灰色显示助手默认预览 */}
      {sysOverrideOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setSysOverrideOpen(false)}>
          <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl w-[520px] max-h-[70vh] flex flex-col p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold mb-1">{t('chat.sysOverride.title')}</h3>
            <p className="text-xs text-[var(--color-text-muted)] mb-3">
              {assistant?.systemPrompt ? t('chat.sysOverride.ph') : t('chat.sysOverride.phNoAssistant')}
            </p>
            {!systemPromptOverride && assistant?.systemPrompt && (
              <div className="mb-3 p-2.5 rounded bg-[var(--color-hover-overlay)] text-[11px] text-[var(--color-text-muted)] max-h-24 overflow-y-auto whitespace-pre-wrap">
                {assistant.systemPrompt.slice(0, 500)}{assistant.systemPrompt.length > 500 ? '…' : ''}
              </div>
            )}
            <textarea
              autoFocus
              value={sysOverrideText}
              onChange={(e) => setSysOverrideText(e.target.value)}
              placeholder={t('chat.sysOverride.ph')}
              rows={6}
              className="w-full px-3 py-2 border border-[var(--color-border)] rounded bg-[var(--color-input-bg)] text-sm outline-none focus:border-[var(--color-accent)] resize-y"
            />
            <div className="flex gap-2 mt-4 justify-end">
              <button
                onClick={() => { setSysOverrideOpen(false); onSetSystemPromptOverride?.(null) }}
                className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover)] text-[var(--color-text-muted)]"
              >
                {t('chat.sysOverride.clear')}
              </button>
              <button
                onClick={() => setSysOverrideOpen(false)}
                className="px-3 py-1.5 text-xs border border-[var(--color-border)] rounded hover:bg-[var(--color-hover)]"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={() => {
                  const v = sysOverrideText.trim() || null
                  onSetSystemPromptOverride?.(v)
                  setSysOverrideOpen(false)
                }}
                className="px-3 py-1.5 text-xs bg-[var(--color-accent)] text-white rounded hover:opacity-90"
              >
                {t('chat.sysOverride.save')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 输入框下方：对话配置条（技能/知识库/工具权限/临时提示词） */}
      <div className="shrink-0 px-4 pb-3">
        <ChatConfigBar
          assistant={assistant}
          onAssistantUpdated={onAssistantUpdated}
        />
      </div>
    </div>
  )
}
