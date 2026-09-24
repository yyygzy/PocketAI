// 聊天服务：一问多答多目标并发
// 同一段输入 → 共享一份上下文 → N 个模型各产生一条 assistant 消息 → 流式事件按 targetIndex 分发
// agentMode=true 时委托 AgentEngine 走 ReAct 循环
import { IPC } from '../../shared/types'
import type {
  SendMessagePayload,
  RegeneratePayload,
  ResendPayload,
  ChatTarget,
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent
} from '../../shared/types'
import { providerManager } from '../providers/manager'
import { acquireKeepAwake, releaseKeepAwake } from '../keep-awake'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { renderPrompt } from '../assistant/prompt-template'
import { buildSkillsContext } from '../assistant/skills'
import { ragService } from '../knowledge/rag'
import { errMsg, isAbortError } from '../error'
import { withProviderLimit } from './concurrency'
import { agentEngine } from '../agent/engine'
import { injectAttachments, appendTextAttachments, buildImageParts } from './context-attachments'
import type { AdapterChatMessage } from '../providers/types'
import type { MessageRecord } from '../../shared/types'

type EmitFn = (channel: string, data: unknown) => void

/** 按 batch 分组一轮回复：有 batchId 按 batchId 归组；旧数据（null）按“连续 5 秒内”归为同批 */
function groupRepliesByBatch(replies: MessageRecord[]): MessageRecord[][] {
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
 * 挑出每轮 user 消息对应的“激活分支”回复 ID 集合：
 * 从最新批次往前找第一条 done 回复（失败批次自动回退到上一个可用分支）。
 */
function pickActiveReplyIds(history: MessageRecord[]): Set<string> {
  const chosen = new Set<string>()
  let pending: MessageRecord[] = []
  const flush = (): void => {
    if (pending.length === 0) return
    const batches = groupRepliesByBatch(pending)
    for (let i = batches.length - 1; i >= 0; i--) {
      const batch = batches[i]
      if (!batch) continue
      const done = batch.find((r) => r.status === 'done')
      if (done) {
        chosen.add(done.id)
        break
      }
    }
    pending = []
  }
  for (const m of history) {
    if (m.role === 'user') flush()
    else if (m.role === 'assistant') pending.push(m)
  }
  flush()
  return chosen
}

/**
 * 组装上下文：历史中一轮 user 后可能有多条 assistant（分支/对照回复），
 * 只取该轮激活分支（最新批次）的第一条 done 回复进入上下文，保证角色交替合法。
 */
function buildContext(history: MessageRecord[], systemPrompt?: string): AdapterChatMessage[] {
  const out: AdapterChatMessage[] = []
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt })
  }
  const activeReplyIds = pickActiveReplyIds(history)
  let awaitingAssistant = false
  for (const m of history) {
    if (m.status !== 'done') continue
    if (m.role === 'user') {
      // 如果用户消息带附件，还原为 multimodal content
      if (m.attachments && m.attachments.length > 0) {
        const textAttachments = m.attachments.filter(a => a.type === 'text')
        const imageAttachments = m.attachments.filter(a => a.type === 'image')
        const text = appendTextAttachments(m.content, textAttachments)
        if (imageAttachments.length > 0) {
          out.push({ role: 'user', content: buildImageParts(text, imageAttachments) })
        } else {
          out.push({ role: 'user', content: text })
        }
      } else {
        out.push({ role: 'user', content: m.content })
      }
      awaitingAssistant = true
    } else if (m.role === 'assistant' && awaitingAssistant) {
      if (!activeReplyIds.has(m.id)) continue // 非激活分支的回复不进上下文
      out.push({ role: 'assistant', content: m.content })
      awaitingAssistant = false
    }
    // 无前置 user 的 assistant 或多余的分支回复，均不进上下文
  }
  return out
}

class ChatService {
  private controllers = new Map<string, AbortController>()
  /** 会话级互斥锁：同一 conversationId 的 send/regenerate/resend 串行执行，
   *  避免 Web 端与 IM 通道并发写入导致上下文重建错乱。 */
  private conversationLocks = new Map<string, Promise<unknown>>()

  abort(requestId: string): void {
    this.controllers.get(requestId)?.abort()
    // Agent 模式共用同一 requestId
    agentEngine.abort(requestId)
  }

  /**
   * 会话级串行锁：前序任务失败不阻塞后续（catch 吞掉），
   * finally 中若无等待者则从 Map 清理，避免内存增长。
   */
  private withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.conversationLocks.get(conversationId) ?? Promise.resolve()
    let resolveNext!: () => void
    const next = new Promise<void>((r) => {
      resolveNext = r
    })
    this.conversationLocks.set(conversationId, next)
    return (async () => {
      try {
        // 串行锁链：上个任务的失败不阻断当前任务（每个任务自己有 try/catch），吞错即可
        await prev.catch(() => {})
        return await fn()
      } finally {
        resolveNext()
        if (this.conversationLocks.get(conversationId) === next) {
          this.conversationLocks.delete(conversationId)
        }
      }
    })()
  }

  async send(payload: SendMessagePayload, emit: EmitFn): Promise<void> {
    return this.withConversationLock(payload.conversationId, async () => {
    const { requestId, conversationId, content, targets, assistantId } = payload
    if (!targets || targets.length === 0) throw new Error('未选择模型')

    // Agent 模式：委托给 AgentEngine 走 ReAct 循环
    if (payload.agentMode) {
      acquireKeepAwake() // 生成期间阻止系统睡眠（锁屏后台保活）
      try {
        await agentEngine.run(payload, emit)
      } finally {
        releaseKeepAwake()
      }
      return
    }

    // 解析有效 SystemPrompt：助手模板（渲染变量后）
    let effectivePrompt = ''
    let assistantKbIds: string[] = []
    let assistantSkillIds: string[] = []
    if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      effectivePrompt = assistant?.systemPrompt ?? ''
      assistantKbIds = assistant?.knowledgeBaseIds ?? []
      assistantSkillIds = assistant?.skillIds ?? []
    }

    // 若模板含 {{knowledge}} 且助手关联了知识库，则检索注入
    let knowledgeContext = ''
    let sources: Array<{ chunkId: string; docId: string; docTitle: string; content: string }> = []
    if (effectivePrompt.includes('{{knowledge}}') && assistantKbIds.length > 0) {
      try {
        const result = await ragService.retrieve(assistantKbIds, content)
        knowledgeContext = ragService.buildContext(result.chunks)
        sources = result.chunks.map((c) => ({
          chunkId: c.chunkId,
          docId: c.docId,
          docTitle: c.docTitle,
          content: c.content
        }))
      } catch {
        // 检索失败不阻断对话，仅跳过知识注入
      }
    }

    const skillsContext = buildSkillsContext(assistantSkillIds)
    const renderedPrompt = renderPrompt(effectivePrompt, {
      knowledge: knowledgeContext,
      skills: skillsContext
    })

    // 主控制器：停止时中断全部目标
    const master = new AbortController()
    this.controllers.set(requestId, master)
    acquireKeepAwake() // 生成期间阻止系统睡眠（锁屏后台保活）

    try {
      // 1. 持久化用户消息
      const userMsg = messageRepo.insert({
        conversationId,
        role: 'user',
        content,
        status: 'done',
        attachments: payload.attachments
      })

      // 2. 会话标题与状态
      const conv = conversationRepo.get(conversationId)
      if (conv && (conv.title === '新对话' || !conv.title)) {
        conversationRepo.rename(conversationId, content.slice(0, 20) || '新对话')
      }
      conversationRepo.touch(conversationId, {
        modelLabel: targets.map((t) => `${t.providerId}:${t.model}`).join(' | '),
        status: 'streaming'
      })

      // 3. 构建共享上下文（此刻历史含刚插入的用户消息，不含占位回复）
      const messages = buildContext(messageRepo.listByConversation(conversationId), renderedPrompt)

      // 3.5 注入附件：图片→multimodal 格式，文本→追加到消息内容
      injectAttachments(messages, payload.attachments)
      const placeholders = targets.map((t) =>
        messageRepo.insert({
          conversationId,
          role: 'assistant',
          content: '',
          provider: t.providerId,
          model: t.model,
          status: 'streaming',
          parentId: userMsg.id,
          batchId: requestId
        })
      )

      // 5. 并发执行（同 Provider 自动限流）
      const results = await Promise.allSettled(
        targets.map((target, index) =>
          this.runTarget({
            requestId,
            index,
            target,
            messages,
            messageId: placeholders[index]!.id,
            signal: master.signal,
            emit,
            sources
          })
        )
      )

      // 全部目标失败 → 标记 error；否则 done
      const allFailed = results.every((r) => r.status === 'rejected')
      conversationRepo.touch(conversationId, { status: allFailed ? 'error' : 'done' })
    } finally {
      this.controllers.delete(requestId)
      releaseKeepAwake()
    }
    })
  }

  /** 重新生成：保留旧回复作为分支，用相同上下文追加一个新批次回复 */
  async regenerate(payload: RegeneratePayload, emit: EmitFn): Promise<void> {
    return this.withConversationLock(payload.conversationId, async () => {
    const { requestId, conversationId, messageId, targets, assistantId } = payload
    if (!targets || targets.length === 0) throw new Error('未选择模型')

    // 获取要重新生成的旧 assistant 消息（仅用于校验与取 parent）
    const oldMsg = messageRepo.getById(messageId)
    if (!oldMsg || oldMsg.role !== 'assistant') {
      throw new Error('消息不存在或非助手消息')
    }

    // 解析 SystemPrompt
    let effectivePrompt = ''
    if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      effectivePrompt = assistant?.systemPrompt ?? ''
    }
    const renderedPrompt = renderPrompt(effectivePrompt, {})

    // 构建上下文（旧回复保留在历史中，buildContext 只取激活分支）
    const messages = buildContext(messageRepo.listByConversation(conversationId), renderedPrompt)

    // 主控制器
    const master = new AbortController()
    this.controllers.set(requestId, master)
    acquireKeepAwake() // 生成期间阻止系统睡眠（锁屏后台保活）

    try {
      // 为每个目标创建占位 assistant 消息（新批次 = 新分支）
      const placeholders = targets.map((t) =>
        messageRepo.insert({
          conversationId,
          role: 'assistant',
          content: '',
          provider: t.providerId,
          model: t.model,
          status: 'streaming',
          parentId: oldMsg.parentId,
          batchId: requestId
        })
      )

      conversationRepo.touch(conversationId, { status: 'streaming' })

      // 并发执行
      const results = await Promise.allSettled(
        targets.map((target, index) =>
          this.runTarget({
            requestId,
            index,
            target,
            messages,
            messageId: placeholders[index]!.id,
            signal: master.signal,
            emit
          })
        )
      )

      const allFailed = results.every((r) => r.status === 'rejected')
      conversationRepo.touch(conversationId, { status: allFailed ? 'error' : 'done' })
    } finally {
      this.controllers.delete(requestId)
      releaseKeepAwake()
    }
    })
  }

  /** 改参重跑 / 编辑用户消息后重发：保留旧回复作为分支，追加一个新批次回复 */
  async resend(payload: ResendPayload, emit: EmitFn): Promise<void> {
    return this.withConversationLock(payload.conversationId, async () => {
    const { requestId, conversationId, messageId, content, targets, assistantId } = payload
    if (!targets || targets.length === 0) throw new Error('未选择模型')

    const userMsg = messageRepo.getById(messageId)
    if (!userMsg || userMsg.role !== 'user') {
      throw new Error('消息不存在或非用户消息')
    }

    // 如果提供了新内容，更新用户消息（旧回复保留为分支，可切换查看）
    if (content !== undefined && content !== userMsg.content) {
      messageRepo.updateUserContent(messageId, content)
    }

    // 解析 SystemPrompt
    let effectivePrompt = ''
    if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      effectivePrompt = assistant?.systemPrompt ?? ''
    }
    const renderedPrompt = renderPrompt(effectivePrompt, {})

    // 构建上下文（旧回复保留为分支，buildContext 只取激活分支）
    const messages = buildContext(messageRepo.listByConversation(conversationId), renderedPrompt)

    const master = new AbortController()
    this.controllers.set(requestId, master)
    acquireKeepAwake() // 生成期间阻止系统睡眠（锁屏后台保活）

    try {
      // 为每个目标创建占位 assistant 消息（新批次 = 新分支）
      const placeholders = targets.map((t) =>
        messageRepo.insert({
          conversationId,
          role: 'assistant',
          content: '',
          provider: t.providerId,
          model: t.model,
          status: 'streaming',
          parentId: messageId,
          batchId: requestId
        })
      )

      conversationRepo.touch(conversationId, { status: 'streaming' })

      const results = await Promise.allSettled(
        targets.map((target, index) =>
          this.runTarget({
            requestId,
            index,
            target,
            messages,
            messageId: placeholders[index]!.id,
            signal: master.signal,
            emit
          })
        )
      )

      const allFailed = results.every((r) => r.status === 'rejected')
      conversationRepo.touch(conversationId, { status: allFailed ? 'error' : 'done' })
    } finally {
      this.controllers.delete(requestId)
      releaseKeepAwake()
    }
    })
  }

  private async runTarget(args: {
    requestId: string
    index: number
    target: ChatTarget
    messages: AdapterChatMessage[]
    messageId: string
    signal: AbortSignal
    emit: EmitFn
    sources?: Array<{ chunkId: string; docId: string; docTitle: string; content: string }>
  }): Promise<void> {
    const { requestId, index, target, messages, messageId, signal, emit, sources } = args

    let accumulated = ''

    const sendChunk = (delta: string): void => {
      accumulated += delta
      const e: ChatChunkEvent = { requestId, targetIndex: index, messageId, delta }
      emit(IPC.CHAT_CHUNK_EVENT, e)
    }

    try {
      const result = await withProviderLimit(target.providerId, () => {
        const adapter = providerManager.getAdapter(target.providerId)
        return adapter.streamChat(
          messages,
          { model: target.model, signal },
          { onDelta: sendChunk }
        )
      })

      const full = result.content
      messageRepo.updateContent(messageId, full, 'done', sources)
      const e: ChatDoneEvent = { requestId, targetIndex: index, messageId, fullContent: full, sources }
      emit(IPC.CHAT_DONE_EVENT, e)
    } catch (err) {
      const aborted = isAbortError(err)
      // 中止/出错时保留已流式生成的部分内容
      const partial = accumulated
      const finalContent = aborted
        ? partial || '_(已停止)_'
        : partial || `请求失败: ${errMsg(err)}`
      messageRepo.updateContent(messageId, finalContent, aborted ? 'aborted' : 'error', sources)

      if (aborted) {
        const e: ChatDoneEvent = {
          requestId,
          targetIndex: index,
          messageId,
          fullContent: partial,
          sources
        }
        emit(IPC.CHAT_DONE_EVENT, e)
      } else {
        const e: ChatErrorEvent = {
          requestId,
          targetIndex: index,
          messageId,
          error: errMsg(err)
        }
        emit(IPC.CHAT_ERROR_EVENT, e)
      }
    }
  }
}

export const chatService = new ChatService()
