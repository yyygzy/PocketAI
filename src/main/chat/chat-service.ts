// 聊天服务：一问多答多目标并发
// 同一段输入 → 共享一份上下文 → N 个模型各产生一条 assistant 消息 → 流式事件按 targetIndex 分发
// agentMode=true 时委托 AgentEngine 走 ReAct 循环
import { IPC } from '../../shared/types'
import type {
  SendMessagePayload,
  ChatTarget,
  ChatChunkEvent,
  ChatDoneEvent,
  ChatErrorEvent
} from '../../shared/types'
import { providerManager } from '../providers/manager'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { renderPrompt } from '../assistant/prompt-template'
import { buildSkillsContext } from '../assistant/skills'
import { ragService } from '../knowledge/rag'
import { withProviderLimit } from './concurrency'
import { agentEngine } from '../agent/engine'
import type { AdapterChatMessage } from '../providers/types'
import type { MessageRecord } from '../../shared/types'

type EmitFn = (channel: string, data: unknown) => void

/**
 * 组装上下文：历史中若一轮 user 后有多条 assistant（对照回复），
 * 只取第一条 done 回复进入上下文，保证 messages 角色交替合法。
 */
function buildContext(history: MessageRecord[], systemPrompt?: string): AdapterChatMessage[] {
  const out: AdapterChatMessage[] = []
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt })
  }
  let awaitingAssistant = false
  for (const m of history) {
    if (m.status !== 'done') continue
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.content })
      awaitingAssistant = true
    } else if (m.role === 'assistant' && awaitingAssistant) {
      out.push({ role: 'assistant', content: m.content })
      awaitingAssistant = false
    }
    // 无前置 user 的 assistant 或多余的对照回复，均不进上下文
  }
  return out
}

class ChatService {
  private controllers = new Map<string, AbortController>()

  abort(requestId: string): void {
    this.controllers.get(requestId)?.abort()
    // Agent 模式共用同一 requestId
    agentEngine.abort(requestId)
  }

  async send(payload: SendMessagePayload, emit: EmitFn): Promise<void> {
    const { requestId, conversationId, content, targets, assistantId } = payload
    if (!targets || targets.length === 0) throw new Error('未选择模型')

    // Agent 模式：委托给 AgentEngine 走 ReAct 循环
    if (payload.agentMode) {
      await agentEngine.run(payload, emit)
      return
    }

    // 解析有效 SystemPrompt：单轮临时覆盖 > 助手模板（渲染变量后）
    let effectivePrompt = ''
    let assistantKbIds: string[] = []
    let assistantSkillIds: string[] = []
    if (payload.systemPrompt !== undefined) {
      effectivePrompt = payload.systemPrompt
    } else if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      effectivePrompt = assistant?.systemPrompt ?? ''
      assistantKbIds = assistant?.knowledgeBaseIds ?? []
      assistantSkillIds = assistant?.skillIds ?? []
    }

    // 若模板含 {{knowledge}} 且助手关联了知识库，则检索注入
    let knowledgeContext = ''
    if (effectivePrompt.includes('{{knowledge}}') && assistantKbIds.length > 0) {
      try {
        const result = await ragService.retrieve(assistantKbIds, content)
        knowledgeContext = ragService.buildContext(result.chunks)
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

    // 1. 持久化用户消息
    const userMsg = messageRepo.insert({
      conversationId,
      role: 'user',
      content,
      status: 'done'
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

    // 4. 为每个目标创建占位 assistant 消息（parentId 指向同一条用户消息）
    const placeholders = targets.map((t) =>
      messageRepo.insert({
        conversationId,
        role: 'assistant',
        content: '',
        provider: t.providerId,
        model: t.model,
        status: 'streaming',
        parentId: userMsg.id
      })
    )

    // 5. 并发执行（同 Provider 自动限流）
    await Promise.allSettled(
      targets.map((target, index) =>
        this.runTarget({
          requestId,
          index,
          target,
          messages,
          messageId: placeholders[index].id,
          signal: master.signal,
          emit
        })
      )
    )

    conversationRepo.touch(conversationId, { status: 'done' })
    this.controllers.delete(requestId)
  }

  private async runTarget(args: {
    requestId: string
    index: number
    target: ChatTarget
    messages: AdapterChatMessage[]
    messageId: string
    signal: AbortSignal
    emit: EmitFn
  }): Promise<void> {
    const { requestId, index, target, messages, messageId, signal, emit } = args

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
      messageRepo.updateContent(messageId, full, 'done')
      const e: ChatDoneEvent = { requestId, targetIndex: index, messageId, fullContent: full }
      emit(IPC.CHAT_DONE_EVENT, e)
    } catch (err) {
      const aborted = (err as Error).name === 'AbortError'
      // 中止/出错时保留已流式生成的部分内容
      const partial = accumulated
      const finalContent = aborted
        ? partial || '_(已停止)_'
        : partial || `请求失败: ${(err as Error).message}`
      messageRepo.updateContent(messageId, finalContent, aborted ? 'aborted' : 'error')

      if (aborted) {
        const e: ChatDoneEvent = {
          requestId,
          targetIndex: index,
          messageId,
          fullContent: partial
        }
        emit(IPC.CHAT_DONE_EVENT, e)
      } else {
        const e: ChatErrorEvent = {
          requestId,
          targetIndex: index,
          messageId,
          error: (err as Error).message
        }
        emit(IPC.CHAT_ERROR_EVENT, e)
      }
    }
  }
}

export const chatService = new ChatService()
