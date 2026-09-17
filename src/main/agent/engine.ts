// Work Agent 引擎（M4.3）：带工具权限 + 多步 ReAct 循环
// 流程：
//   1. 组装上下文 + 工具 schema → 渲染 SystemPrompt（{{tools}}/{{knowledge}}）
//   2. 持久化 user 消息
//   3. 循环（最多 maxSteps 轮，默认 10）：
//      a. 调 LLM（messages + tools），流式输出 thought → 写入 DB assistant 消息
//      b. 若返回 tool_calls：逐个执行 → 写入 DB tool 消息 → 进入下一轮
//      c. 若无 tool_calls：视为最终回答，结束
//   4. 整体超时 5 分钟，单工具调用 30s

import { IPC } from '../../shared/types'
import type {
  SendMessagePayload,
  AgentStepEvent,
  AgentDoneEvent,
  AgentErrorEvent,
  ChatTarget,
  ToolCall,
  ToolResult,
  MessageRecord
} from '../../shared/types'
import { providerManager } from '../providers/manager'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { renderPrompt } from '../assistant/prompt-template'
import { buildSkillsContext } from '../assistant/skills'
import { ragService } from '../knowledge/rag'
import { toolRegistry } from '../tools/registry'
import type { AdapterChatMessage } from '../providers/types'

const MAX_STEPS = 10
const LOOP_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟整体超时
const TOOL_TIMEOUT_MS = 30_000 // 单个工具调用超时

type EmitFn = (channel: string, data: unknown) => void

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
    } else if (m.role === 'tool' && out.length > 0) {
      // 还原上一轮 tool 消息
      try {
        const tr = JSON.parse(m.content) as ToolResult
        const lastAssistant = findLastAssistantWithToolCallId(out, tr.toolCallId)
        out.push({
          role: 'tool',
          content: tr.content,
          tool_call_id: tr.toolCallId,
          name: tr.name
        })
        // 若没找到对应的 assistant.tool_calls，依然追加（某些模型能容忍）
        void lastAssistant
      } catch {
        // 老消息格式，跳过
      }
    }
  }
  return out
}

function findLastAssistantWithToolCallId(
  msgs: AdapterChatMessage[],
  toolCallId: string
): AdapterChatMessage | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && m.tool_calls?.some((tc: ToolCall) => tc.id === toolCallId)) {
      return m
    }
  }
  return null
}

class AgentEngine {
  private controllers = new Map<string, AbortController>()

  abort(requestId: string): void {
    this.controllers.get(requestId)?.abort()
  }

  async run(payload: SendMessagePayload, emit: EmitFn): Promise<void> {
    const { requestId, conversationId, content, assistantId, targets } = payload
    if (!targets || targets.length === 0) throw new Error('未选择模型')
    const target: ChatTarget = targets[0] // Agent 模式只取第一个目标

    // 解析助手配置
    let effectivePrompt = ''
    let toolPermissions: string[] = []
    let kbIds: string[] = []
    let skillIds: string[] = []
    let defaultParams: Record<string, unknown> | null = null
    if (payload.systemPrompt !== undefined) {
      effectivePrompt = payload.systemPrompt
    } else if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      effectivePrompt = assistant?.systemPrompt ?? ''
      toolPermissions = assistant?.toolPermissions ?? []
      kbIds = assistant?.knowledgeBaseIds ?? []
      skillIds = assistant?.skillIds ?? []
      defaultParams = assistant?.defaultParams ?? null
    }

    // 知识库检索注入
    let knowledgeContext = ''
    if (effectivePrompt.includes('{{knowledge}}') && kbIds.length > 0) {
      try {
        const result = await ragService.retrieve(kbIds, content)
        knowledgeContext = ragService.buildContext(result.chunks)
      } catch {
        // 检索失败不阻断
      }
    }

    // 工具 schema 与 {{tools}}
    const tools = toolRegistry.filterByPermissions(toolPermissions)
    const toolsText = toolRegistry.formatForPrompt(tools)

    const skillsContext = buildSkillsContext(skillIds)
    const renderedPrompt = renderPrompt(effectivePrompt, {
      knowledge: knowledgeContext,
      tools: toolsText,
      skills: skillsContext
    })

    // 持久化用户消息
    const userMsg = messageRepo.insert({
      conversationId,
      role: 'user',
      content,
      status: 'done'
    })

    // 会话标题与状态
    const conv = conversationRepo.get(conversationId)
    if (conv && (conv.title === '新对话' || !conv.title)) {
      conversationRepo.rename(conversationId, content.slice(0, 20) || '新对话')
    }
    conversationRepo.touch(conversationId, {
      modelLabel: `agent:${target.providerId}:${target.model}`,
      status: 'streaming'
    })

    // 主控制器
    const master = new AbortController()
    this.controllers.set(requestId, master)
    const loopTimer = setTimeout(() => master.abort(), LOOP_TIMEOUT_MS)

    // 工作消息列表（ReAct 上下文）
    const messages = buildContext(
      messageRepo.listByConversation(conversationId),
      renderedPrompt
    )

    // 允许调用的工具 id 集合
    const allowedToolIds = new Set<string>(
      toolPermissions.includes('*') ? ['*'] : toolPermissions
    )

    let stepCount = 0
    let finalContent = ''
    let finalMessageId = ''

    try {
      while (stepCount < MAX_STEPS) {
        if (master.signal.aborted) throw new Error('Agent 运行已中止')

        stepCount++
        const stepIndex = stepCount

        // 创建本轮 assistant 占位消息
        const assistantMsg = messageRepo.insert({
          conversationId,
          role: 'assistant',
          content: '',
          provider: target.providerId,
          model: target.model,
          status: 'streaming',
          parentId: userMsg.id
        })

        // 调用 LLM
        let accumulated = ''
        const adapter = providerManager.getAdapter(target.providerId)
        const chatParams: any = {
          model: target.model,
          signal: master.signal,
          ...(defaultParams ?? {})
        }
        if (tools.length > 0) {
          chatParams.tools = tools
        }

        let result
        try {
          result = await adapter.streamChat(messages, chatParams, {
            onDelta: (delta) => {
              accumulated += delta
              // 推送 thought 文本增量（前端可拼接到当前 step 的 assistant 消息）
              emit(IPC.AGENT_CHUNK_EVENT, {
                requestId,
                conversationId,
                stepIndex,
                messageId: assistantMsg.id,
                delta
              })
            }
          })
        } catch (e) {
          // 失败保留已生成部分
          const partial = accumulated || `_(LLM 调用失败: ${(e as Error).message})_`
          messageRepo.updateContent(assistantMsg.id, partial, 'error')
          if ((e as Error).name === 'AbortError') throw e
          // 非 abort 错误：emit step error，并终止
          const evt: AgentStepEvent = {
            requestId,
            conversationId,
            stepIndex,
            type: 'error',
            error: (e as Error).message,
            messageId: assistantMsg.id
          }
          emit(IPC.AGENT_STEP_EVENT, evt)
          throw e
        }

        // 写入本步 assistant 文本
        const stepText = result.content || ''
        messageRepo.updateContent(assistantMsg.id, stepText, 'done')

        // 把 assistant 步骤消息加入上下文（保留 tool_calls 以便 LLM 看到自己的调用历史）
        const toolCalls = result.toolCalls
        const assistantAdapterMsg: AdapterChatMessage = {
          role: 'assistant',
          content: stepText,
          ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
        }
        messages.push(assistantAdapterMsg)

        // emit thought step
        const thoughtEvt: AgentStepEvent = {
          requestId,
          conversationId,
          stepIndex,
          type: 'thought',
          text: stepText,
          messageId: assistantMsg.id
        }
        emit(IPC.AGENT_STEP_EVENT, thoughtEvt)

        // 无 tool_calls → 最终回答
        if (!toolCalls || toolCalls.length === 0) {
          finalContent = stepText
          finalMessageId = assistantMsg.id
          // 标记最后一步
          const finalEvt: AgentStepEvent = {
            requestId,
            conversationId,
            stepIndex,
            type: 'final',
            text: stepText,
            messageId: assistantMsg.id,
            done: true
          }
          emit(IPC.AGENT_STEP_EVENT, finalEvt)
          break
        }

        // 有 tool_calls → 逐个执行
        for (const tc of toolCalls) {
          if (master.signal.aborted) throw new Error('Agent 运行已中止')

          // emit tool_call step
          const callEvt: AgentStepEvent = {
            requestId,
            conversationId,
            stepIndex,
            type: 'tool_call',
            toolCall: tc
          }
          emit(IPC.AGENT_STEP_EVENT, callEvt)

          // 执行（带 30s 超时）
          const toolResult = await this.executeWithTimeout(
            tc,
            allowedToolIds
          )

          // 持久化 tool 消息（content 存 JSON）
          const toolMsg = messageRepo.insert({
            conversationId,
            role: 'tool',
            content: JSON.stringify({
              toolCallId: toolResult.toolCallId || tc.id,
              name: toolResult.name,
              content: toolResult.content,
              isError: toolResult.isError ?? false
            }),
            parentId: assistantMsg.id,
            status: 'done'
          })

          // 追加到 messages（OpenAI 格式：role=tool, content, tool_call_id, name）
          const toolAdapterMsg: AdapterChatMessage = {
            role: 'tool',
            content: toolResult.content,
            tool_call_id: tc.id,
            name: tc.function.name
          }
          messages.push(toolAdapterMsg)

          // emit tool_result step
          const resultEvt: AgentStepEvent = {
            requestId,
            conversationId,
            stepIndex,
            type: 'tool_result',
            toolResult: { ...toolResult, toolCallId: tc.id },
            messageId: toolMsg.id
          }
          emit(IPC.AGENT_STEP_EVENT, resultEvt)
        }
      }

      // 超过最大步数仍未结束
      if (!finalMessageId) {
        const evt: AgentErrorEvent = {
          requestId,
          conversationId,
          error: `已达最大推理步数（${MAX_STEPS}）`
        }
        emit(IPC.AGENT_ERROR_EVENT, evt)
        conversationRepo.touch(conversationId, { status: 'error' })
        return
      }

      const doneEvt: AgentDoneEvent = {
        requestId,
        conversationId,
        finalMessageId,
        fullContent: finalContent,
        stepCount
      }
      emit(IPC.AGENT_DONE_EVENT, doneEvt)
      conversationRepo.touch(conversationId, { status: 'done' })
    } catch (e) {
      const aborted = (e as Error).name === 'AbortError' || /中止/.test((e as Error).message)
      const errEvt: AgentErrorEvent = {
        requestId,
        conversationId,
        error: aborted ? 'Agent 运行已中止' : (e as Error).message
      }
      emit(IPC.AGENT_ERROR_EVENT, errEvt)
      conversationRepo.touch(conversationId, { status: aborted ? 'aborted' : 'error' })
    } finally {
      clearTimeout(loopTimer)
      this.controllers.delete(requestId)
    }
  }

  private async executeWithTimeout(
    tc: ToolCall,
    allowedToolIds: Set<string>
  ): Promise<ToolResult> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), TOOL_TIMEOUT_MS)
    try {
      // 工具执行内部不直接消费 signal（builtin 是同步 fetch 自带超时；MCP 端 30s 由 client 限制）
      const result = await toolRegistry.execute(tc.function.name, tc.function.arguments, allowedToolIds)
      return result
    } catch (e) {
      return {
        toolCallId: tc.id,
        name: tc.function.name,
        content: `工具执行失败: ${(e as Error).message}`,
        isError: true
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export const agentEngine = new AgentEngine()
