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
  ChatErrorEvent,
  MessageSource,
  MessageRetrieval
} from '../../shared/types'
import { providerManager } from '../providers/manager'
import { acquireKeepAwake, releaseKeepAwake } from '../keep-awake'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { runFirstMessageTitle } from '../conversation/title-gen'
import { messageRepo } from '../db/repositories/message.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { kbRepo } from '../db/repositories/kb.repo'
import { renderPrompt } from '../assistant/prompt-template'
import { buildSkillsContext } from '../assistant/skills'
import { ragService } from '../knowledge/rag'
import { chunksToSources } from '../../shared/kb-sources'
import { noteRetrievalDegradation } from '../knowledge/retrieval-degrade'
import { usageService } from '../usage/usage-service'
import { conversationRunRepo, type ConversationRunSnapshot } from '../db/repositories/conversation-run.repo'
import { resolveAgentToolPermissions, toolPermissionsSignature } from '../agent/tool-permissions'
import { getWorkspaceDir } from '../tools/fs-tools'
import { getUsagePricing } from '../usage/pricing-config'
import { currencySymbolOf } from '../../shared/usage-pricing'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { errMsg, isAbortError } from '../error'
import { createLogger } from '../logger'
import { recordChatStreamPerf, logPerfDebug } from '../steward/perf-probe'
import { checkAndBroadcastBudgetWarnings } from '../usage/budget-warn'
const logger = createLogger('chat-service')
import { withProviderLimit } from './concurrency'
import { agentEngine } from '../agent/engine'
import { markRunStarted, markRunFinished, markRunCheckpoint } from './runtime-registry'
import { injectAttachments, appendTextAttachments, buildImageParts } from './context-attachments'
import type { AdapterChatMessage } from '../providers/types'
import type {
  ChatResumeBlockCode,
  ChatResumeCandidate,
  MessageRecord,
  ResumeChatPayload
} from '../../shared/types'

type EmitFn = (channel: string, data: unknown) => void

/** 续跑准入结果：none=没得续；blocked=有候选但被拦下（入口显示原因）；ready=可续 */
type ResumeEvaluation =
  | { kind: 'none' }
  | { kind: 'blocked'; candidate: ChatResumeCandidate }
  | { kind: 'ready'; candidate: ChatResumeCandidate; run: ConversationRunSnapshot; anchor: MessageRecord }

/** 续跑被拦下时的回码（渲染层按 code 查静态四语键；这里的文案只进日志/兜底） */
function resumeBlockedError(code: ChatResumeBlockCode): Error {
  switch (code) {
    case 'RESUME_ANCHOR_MISSING':
      return new Error('RESUME_ANCHOR_MISSING:原来的用户消息已不在，无法接着跑，请重新发送')
    case 'RESUME_ARTIFACTS_MISMATCH':
      return new Error('RESUME_ARTIFACTS_MISMATCH:中断点的记录对不上，无法接着跑，请重新发送')
    case 'RESUME_TOOLS_EXECUTED':
      return new Error('RESUME_TOOLS_EXECUTED:中断前已有工具执行过，为避免重复执行，请重新发送')
    case 'RESUME_WORKSPACE_CHANGED':
      return new Error('RESUME_WORKSPACE_CHANGED:工作目录已变更，为避免在错误的目录里续跑，请重新发送')
    case 'RESUME_TOOL_PERMISSIONS_CHANGED':
      return new Error('RESUME_TOOL_PERMISSIONS_CHANGED:工具授权已变更，请重新发送')
    case 'RESUME_TARGET_MISSING':
      return new Error('RESUME_TARGET_MISSING:会话的模型已不可用，请重新选择模型后发送')
  }
}

/** 会话的 modelLabel 形如 `providerId:model`；解析不出来就不猜（续跑要求目标明确） */
function parseModelLabel(label: string | null): ChatTarget | null {
  if (!label) return null
  const idx = label.indexOf(':')
  if (idx <= 0 || idx === label.length - 1) return null
  return { providerId: label.slice(0, idx), model: label.slice(idx + 1) }
}

/**
 * 工作目录比对：只做"是不是同一个位置"的判断。
 * Windows/macOS 路径大小写与尾部分隔符不携带语义，比较前统一；不做 realpath（目录被换到别处也算变化）。
 */
function sameWorkspaceDir(a: string, b: string): boolean {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

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
        // kb 类型附件不进上下文（kbId 已在发送时通过 kbRefs 参与检索）
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
    if (!targets || targets.length === 0) throw new Error('CHAT_NO_TARGET:未选择模型')

    this.assertBudget()

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

    // 解析有效 SystemPrompt：会话级覆盖 > 助手模板 > 空
    // 覆盖优先级：conversation.systemPromptOverride（用户显式设置）> assistant.systemPrompt
    const conv = conversationRepo.get(conversationId)
    const overridePrompt = conv?.systemPromptOverride?.trim() || null
    let effectivePrompt = overridePrompt ?? ''
    let assistantKbIds: string[] = []
    let assistantSkillIds: string[] = []
    if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      if (!effectivePrompt) {
        effectivePrompt = assistant?.systemPrompt ?? ''
      }
      assistantKbIds = assistant?.knowledgeBaseIds ?? []
      assistantSkillIds = assistant?.skillIds ?? []
    }

    // 合并 @ 引用的知识库（kbRefs）与助手默认关联知识库，去重
    const extraKbIds = payload.kbRefs ?? []
    const allKbIds = [...new Set([...assistantKbIds, ...extraKbIds])]

    // 检索触发条件：模板含 {{knowledge}}（助手默认行为）或用户显式 @ 引用了知识库
    const shouldRetrieve = effectivePrompt.includes('{{knowledge}}') || extraKbIds.length > 0
    let knowledgeContext = ''
    let sources: MessageSource[] = []
    // P0-2b：这轮到底有没有检索、命中几条、是否整次失败——如实记录，屏上不再靠 sources.length 猜
    let retrieval: MessageRetrieval = { searched: false, hits: 0 }
    let extraSystemPrompt: string | null = null
    if (shouldRetrieve && allKbIds.length > 0) {
      const tKb = performance.now()
      try {
        const result = await ragService.retrieve(allKbIds, content)
        knowledgeContext = ragService.buildContext(result.chunks)
        sources = chunksToSources(result.chunks)
        retrieval = { searched: true, hits: result.chunks.length, kbCount: allKbIds.length }
        // 模板不含 {{knowledge}} 但用户显式 @ 引用了知识库 → 追加为独立 system 消息
        if (!effectivePrompt.includes('{{knowledge}}') && knowledgeContext) {
          extraSystemPrompt = `以下是与用户问题相关的知识库内容：\n\n${knowledgeContext}`
        }
      } catch (e) {
        retrieval = { searched: true, hits: 0, failed: true, kbCount: allKbIds.length }
        noteRetrievalDegradation(
          {
            stage: 'retrieve',
            reason: `对话侧知识库检索整次失败，本轮未注入任何资料：${errMsg(e, '未知错误')}`
          },
          performance.now() - tKb
        )
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
        attachments: payload.attachments,
        replyToId: payload.replyToId ?? null
      })

      // 2. 会话标题与模型标签
      // 首轮消息：先落截断标题，后台用模型生成短标题（开关可控、失败静默降级）
      runFirstMessageTitle({
        conversationId,
        userContent: content,
        providerId: targets[0]!.providerId,
        model: targets[0]!.model
      })
      conversationRepo.touch(conversationId, {
        modelLabel: targets.map((t) => `${t.providerId}:${t.model}`).join(' | ')
      })
      // B-2：非 Agent 的普通对话也要进运行态注册表（以前只有渲染端本地知道自己在跑）
      markRunStarted({ conversationId, requestId, mode: 'chat' })

      // 3. 构建共享上下文（此刻历史含刚插入的用户消息，不含占位回复）
      const messages = buildContext(messageRepo.listByConversation(conversationId), renderedPrompt)

      // 3.5 若 effectivePrompt 不含 {{knowledge}} 但有额外知识库内容，追加为独立 system 消息
      if (extraSystemPrompt) {
        messages.unshift({ role: 'system', content: extraSystemPrompt })
      }

      // 3.6 注入附件：图片→multimodal 格式，文本→追加到消息内容（kb 类型跳过）
      injectAttachments(messages, payload.attachments)

      // 3.7 附件自动入库到所有关联知识库（文本直接入库，图片需 KB 配 OCR）
      if (payload.attachments && allKbIds.length > 0) {
        void import('../attachment/attachment-ingestion')
          .then(async (m) => {
            for (const kbId of allKbIds) {
              const kb = kbRepo.get(kbId)
              const ocrConfig = kb?.ocrProviderId && kb.ocrModel
                ? { providerId: kb.ocrProviderId, model: kb.ocrModel }
                : null
              await m.ingestAttachmentsToKb(kbId, userMsg.id, payload.attachments!, ocrConfig)
            }
          })
          .catch((e) => logger.warn(`附件入库失败: ${errMsg(e)}`))
      }
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
      // v66：普通对话没有多步，进模型调用前记一次检查点（停在"模型调用中"⇒ 无副作用）
      markRunCheckpoint(conversationId, requestId, { stage: 'model', stepsDone: 0, toolStepsDone: 0 })
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
            sources,
            retrieval
          })
        )
      )

      // 全部目标失败 → 注册表标记 failed；否则 done
      const allFailed = results.every((r) => r.status === 'rejected')
      markRunFinished(conversationId, requestId, allFailed ? 'failed' : 'done')
    } catch (e) {
      // 运行中途抛错（供应商适配器/持久化）：注册表留「失败」角标，错误照原样抛给 IPC 层
      markRunFinished(conversationId, requestId, 'failed', errMsg(e, 'UNKNOWN'))
      throw e
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
    if (!targets || targets.length === 0) throw new Error('CHAT_NO_TARGET:未选择模型')

    this.assertBudget()

    // 获取要重新生成的旧 assistant 消息（仅用于校验与取 parent）
    const oldMsg = messageRepo.getById(messageId)
    if (!oldMsg || oldMsg.role !== 'assistant') {
      throw new Error('CHAT_MSG_NOT_ASSISTANT:消息不存在或非助手消息')
    }

    // 解析 SystemPrompt：会话级覆盖 > 助手模板 > 空
    const conv = conversationRepo.get(conversationId)
    const overridePrompt = conv?.systemPromptOverride?.trim() || null
    let effectivePrompt = overridePrompt ?? ''
    if (assistantId && !effectivePrompt) {
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

      markRunStarted({ conversationId, requestId, mode: 'chat' })

      // 并发执行
      // v66：同上——发出模型调用前落检查点
      markRunCheckpoint(conversationId, requestId, { stage: 'model', stepsDone: 0, toolStepsDone: 0 })
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
      markRunFinished(conversationId, requestId, allFailed ? 'failed' : 'done')
    } catch (e) {
      markRunFinished(conversationId, requestId, 'failed', errMsg(e, 'UNKNOWN'))
      throw e
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
    if (!targets || targets.length === 0) throw new Error('CHAT_NO_TARGET:未选择模型')

    this.assertBudget()

    const userMsg = messageRepo.getById(messageId)
    if (!userMsg || userMsg.role !== 'user') {
      throw new Error('CHAT_MSG_NOT_USER:消息不存在或非用户消息')
    }

    // 如果提供了新内容，更新用户消息（旧回复保留为分支，可切换查看）
    if (content !== undefined && content !== userMsg.content) {
      messageRepo.updateUserContent(messageId, content)
    }

    // 解析 SystemPrompt：会话级覆盖 > 助手模板 > 空
    const conv = conversationRepo.get(conversationId)
    const overridePrompt = conv?.systemPromptOverride?.trim() || null
    let effectivePrompt = overridePrompt ?? ''
    if (assistantId && !effectivePrompt) {
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

      markRunStarted({ conversationId, requestId, mode: 'chat' })

      // v66：发出模型调用前落检查点
      markRunCheckpoint(conversationId, requestId, { stage: 'model', stepsDone: 0, toolStepsDone: 0 })
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
      markRunFinished(conversationId, requestId, allFailed ? 'failed' : 'done')
    } catch (e) {
      markRunFinished(conversationId, requestId, 'failed', errMsg(e, 'UNKNOWN'))
      throw e
    } finally {
      this.controllers.delete(requestId)
      releaseKeepAwake()
    }
    })
  }

  /**
   * P1-3a：续跑候选（只读，打开会话时查）。
   * 只认「该会话最新一条 run 且是 interrupted + resume_state=resumable」：
   * 崩溃后用户已经发过新消息，就说明这一轮被放过了，不能拿更早的断点再续。
   * 这里不抛错：准入不过就返回 blocked（入口显示原因、按钮禁用），比悄悄不显示更诚实。
   */
  getResumeCandidate(conversationId: string): ChatResumeCandidate | null {
    const ev = this.evaluateResume(conversationId)
    return ev.kind === 'none' ? null : ev.candidate
  }

  /**
   * P1-3a：从检查点续跑（范围见 P1-3a 设计稿：只接管 toolStepsDone=0 且停在 preparing/model 的中断）。
   *
   * 三条硬约束：
   * 1. 用**新 requestId** 落新 run 行，旧行保持 interrupted 作审计（不复用旧行，避免 INSERT OR REPLACE 覆盖断点）；
   * 2. 不插用户消息、不重跑规划、不重做附件入库（理由见引擎里 `resume` 分支的注释）；
   * 3. 准入在 markRunStarted 之前完成；任何一项对不上就抛可读回码，不做"尽力而为"的续跑。
   */
  async resume(payload: ResumeChatPayload, emit: EmitFn): Promise<void> {
    return this.withConversationLock(payload.conversationId, async () => {
      const { requestId, conversationId, resumeFromRequestId } = payload
      // 预算闸与正常发送同一道：触顶就照旧抛 BUDGET_EXCEEDED（渲染端已有四语文案）
      this.assertBudget()
      const ev = this.evaluateResume(conversationId)
      if (ev.kind === 'none') throw new Error('RESUME_NOT_FOUND:这次中断已不可续跑，请重新发送')
      if (ev.candidate.requestId !== resumeFromRequestId) {
        throw new Error('RESUME_STALE:这次中断已有新的运行，请重新开始')
      }
      if (ev.kind === 'blocked') throw resumeBlockedError(ev.candidate.code ?? 'RESUME_ARTIFACTS_MISMATCH')

      const conv = conversationRepo.get(conversationId)
      const target = parseModelLabel(conv?.modelLabel ?? null)
      if (!conv || !target) throw resumeBlockedError('RESUME_TARGET_MISSING')

      acquireKeepAwake()
      try {
        await agentEngine.run(
          {
            requestId,
            conversationId,
            assistantId: conv.assistantId,
            content: ev.anchor.content ?? '',
            targets: [target],
            agentMode: true,
            attachments: ev.anchor.attachments
          },
          emit,
          {
            resume: {
              userMessage: ev.anchor,
              startStep: ev.run.stepsDone ?? 0,
              startToolStepsDone: 0,
              workspaceDir: ev.run.workspaceDir,
              toolPermissionsSig: ev.run.toolPermissionsSig
            }
          }
        )
      } finally {
        releaseKeepAwake()
      }
    })
  }

  /**
   * 续跑准入（只读）：候选 → 逐项核对。
   * 顺序有讲究：先看"是不是这一轮"，再看"断点记录对不对"，最后才看"环境有没有变"——
   * 这样用户看到的第一个原因总是最接近根因的那个。
   */
  private evaluateResume(conversationId: string): ResumeEvaluation {
    const run = conversationRunRepo.getLatest(conversationId)
    if (!run || run.status !== 'interrupted') return { kind: 'none' }
    // 普通对话没有续跑入口；restart 的判定在启动对账时已经写下，不再复核
    if (run.mode !== 'agent' || run.resumeState !== 'resumable') return { kind: 'none' }

    const stepsDone = run.stepsDone ?? 0
    const base = {
      requestId: run.requestId,
      conversationId,
      nextStep: stepsDone + 1,
      userMessageId: run.anchorUserMessageId ?? ''
    }
    const blocked = (code: ChatResumeBlockCode): ResumeEvaluation => ({
      kind: 'blocked',
      candidate: { ...base, state: 'blocked', code }
    })

    const anchorId = run.anchorUserMessageId
    if (!anchorId) return blocked('RESUME_ANCHOR_MISSING')
    const anchor = messageRepo.getById(anchorId)
    if (!anchor || anchor.role !== 'user' || anchor.status !== 'done') return blocked('RESUME_ANCHOR_MISSING')

    // 检查点写在步前：已落库的助手条数必须与 steps_done 对齐，否则断点落后一步（见 judgeRunResume 注释）
    const counts = conversationRunRepo.countArtifacts(anchorId)
    if (counts.toolMessages > 0) return blocked('RESUME_TOOLS_EXECUTED')
    if (counts.doneAssistants !== stepsDone) return blocked('RESUME_ARTIFACTS_MISMATCH')

    // 起点快照只在"还没走到第一个检查点"时为空（那种情况下这一步之前什么都没执行，无需比对）
    if (run.workspaceDir && !sameWorkspaceDir(run.workspaceDir, getWorkspaceDir())) {
      return blocked('RESUME_WORKSPACE_CHANGED')
    }
    const conv = conversationRepo.get(conversationId)
    if (!conv) return blocked('RESUME_TARGET_MISSING')
    const assistant = conv.assistantId ? assistantRepo.get(conv.assistantId) : null
    const permissions = resolveAgentToolPermissions(assistant?.toolPermissions, {
      hasAssistant: !!conv.assistantId,
      isBuiltin: assistant?.isBuiltin ?? false
    })
    if (run.toolPermissionsSig && run.toolPermissionsSig !== toolPermissionsSignature(permissions)) {
      return blocked('RESUME_TOOL_PERMISSIONS_CHANGED')
    }
    if (!parseModelLabel(conv.modelLabel)) return blocked('RESUME_TARGET_MISSING')

    return { kind: 'ready', candidate: { ...base, state: 'ready' }, run, anchor }
  }

  /**
   * 预算硬阻断断言：开启后达到日/月上限即抛错（BUDGET_EXCEEDED:scope:limit:currency:msg）。
   * 回码里带上**这次估算所用的币种**：渲染端换文案时符号跟着它，不再写死 ¥
   * （用户可以把币种改成 USD，金额口径与展示符号必须同源）。
   * 未开启或未超限则无操作。
   */
  private assertBudget(): void {
    if (!appConfigRepo.isUsageBudgetHardBlockEnabled()) return
    const pricing = getUsagePricing()
    const exceeded = usageService.checkBudgetExceeded(pricing.prices)
    if (!exceeded) return
    const scopeLabel = exceeded.scope === 'daily' ? '今日' : '本月'
    const symbol = currencySymbolOf(pricing.currency)
    throw new Error(
      `BUDGET_EXCEEDED:${exceeded.scope}:${exceeded.limit}:${pricing.currency}:已达到${scopeLabel}预算上限 ${symbol}${exceeded.limit}`
    )
  }

  private async runTarget(args: {
    requestId: string
    index: number
    target: ChatTarget
    messages: AdapterChatMessage[]
    messageId: string
    signal: AbortSignal
    emit: EmitFn
    sources?: MessageSource[]
    retrieval?: MessageRetrieval
  }): Promise<void> {
    const { requestId, index, target, messages, messageId, signal, emit, sources, retrieval } = args

    let accumulated = ''

    // TTFT/整轮耗时实测（Iter-74）：t0 含 withProviderLimit 排队 = 用户真实体感等待
    const streamStart = performance.now()
    let ttftMs: number | undefined

    const sendChunk = (delta: string): void => {
      if (ttftMs === undefined) ttftMs = performance.now() - streamStart
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

      recordChatStreamPerf({
        kind: 'chat',
        ttftMs,
        totalMs: performance.now() - streamStart,
        model: target.model
      })
      const full = result.content
      messageRepo.updateContent(messageId, full, 'done', sources, result.usage, retrieval)
      // usage 落库后检查预算 80% 软预警（周期标记去重，多 target 只广播一次；内部全 try/catch）
      checkAndBroadcastBudgetWarnings()
      const e: ChatDoneEvent = { requestId, targetIndex: index, messageId, fullContent: full, sources }
      emit(IPC.CHAT_DONE_EVENT, e)
    } catch (err) {
      const aborted = isAbortError(err)
      // 中止/失败的耗时不进慢操作缓冲（无诊断意义），仅 debug 日志
      logPerfDebug(`chat.${aborted ? 'aborted' : 'error'}`, performance.now() - streamStart, `model=${target.model}`)
      // 中止/出错时保留已流式生成的部分内容
      const partial = accumulated
      const finalContent = aborted
        ? partial || '_(已停止)_'
        : partial || `请求失败: ${errMsg(err)}`
      messageRepo.updateContent(messageId, finalContent, aborted ? 'aborted' : 'error', sources, undefined, retrieval)

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
