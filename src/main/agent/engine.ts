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
  ChatAttachment,
  ToolCall,
  ToolResult,
  MessageRecord
} from '../../shared/types'
import { providerManager } from '../providers/manager'
import type { AdapterChatMessage, MessageContentPart } from '../providers/types'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { renderPrompt } from '../assistant/prompt-template'
import { buildSkillsContext } from '../assistant/skills'
import { ragService } from '../knowledge/rag'
import { toolRegistry } from '../tools/registry'
import { getWorkspaceDir, resolveWorkspacePath } from '../tools/fs-tools'
import { classifyCommand } from '../tools/shell-tools'
import { createApproval } from './tool-approval'

const MAX_STEPS = 10
const LOOP_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟整体超时
const TOOL_TIMEOUT_MS = 30_000 // 单个工具调用超时
const MAX_CONTEXT_MESSAGES = 30 // 上下文窗口：最多保留最近 30 条消息（不含 system），防止 token 溢出
const MAX_TOOL_RESULT_CHARS = 2000 // 工具结果在上下文中的最大字符数（截断防止撑爆 token 窗口）
const SUMMARIZE_THRESHOLD = 35 // 历史消息超过此数时，对超出窗口的部分生成摘要

// Agent 默认系统提示词：任务拆解 + 主动工具调用 + ReAct 推理 + 错误恢复 + 记忆感知
const DEFAULT_AGENT_PROMPT = `你是一个智能工作助手（Work Agent），具备多步推理和工具调用能力。请严格遵循以下工作流程：

## 核心原则
1. **主动使用工具**：当用户的问题需要获取实时信息、执行计算、读写文件、搜索内容时，**必须调用对应的工具**，不要凭记忆猜测。不确定时宁可调用工具确认。
2. **任务拆解**：面对复杂任务，先规划子步骤，逐步执行。每一步可以调用工具获取中间结果，再基于结果决定下一步。
3. **诚实透明**：不确定时明确说明，不要编造信息。工具返回错误时如实告知用户，并尝试换一种参数或换一个工具重试。
4. **记忆感知**：你会看到对话历史和前文摘要。如果用户提到"之前说的"、"刚才那个"等，请参考对话历史。

## 工具使用场景
- 用户问时间/日期 → 调用 time_now
- 数学计算 → 调用 calculator，表达式仅支持 + - * / ** % () 和数学函数
- 需要读取网页内容 → 调用 web_fetch（url + 可选 maxChars）
- 用户让你读写文件 → 调用 fs_list / fs_read / fs_write（需工作目录）

## ReAct 推理流程
每一步按以下结构思考并输出：
1. 分析当前需要做什么（简短思考）
2. 决定是否需要调用工具
3. 工具返回后，基于结果继续推理或给出最终回答
4. 如果工具报错，分析原因，尝试修正参数重试或换用其他方法

## 最终回答
当所有必要信息都已获取，直接给出清晰、结构化的最终答案。用 Markdown 格式组织内容。

## 错误恢复策略
- 工具超时或网络错误：告知用户，建议稍后重试
- 参数格式错误：检查参数 JSON 格式，修正后重试
- 工具不存在：说明该功能未启用，提供替代方案

当前日期：{{date}}（{{weekday}}）
当前时间：{{time}}

可用工具列表：
{{tools}}

{{knowledge}}`

type EmitFn = (channel: string, data: unknown) => void

/** 将附件注入到上下文最后一条 user 消息（构建 multimodal 格式） */
function injectAttachments(messages: AdapterChatMessage[], attachments?: ChatAttachment[]): void {
  if (!attachments || attachments.length === 0) return
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const textContent = typeof messages[i].content === 'string' ? messages[i].content as string : ''
      const textAttachments = attachments.filter(a => a.type === 'text')
      const imageAttachments = attachments.filter(a => a.type === 'image')
      let text = textContent
      for (const ta of textAttachments) {
        text += `\n\n--- ${ta.name} ---\n${ta.data}`
      }
      if (imageAttachments.length > 0) {
        const parts: MessageContentPart[] = [
          { type: 'text', text },
          ...imageAttachments.map(a => ({ type: 'image_url' as const, image_url: { url: a.data } }))
        ]
        messages[i].content = parts
      } else {
        messages[i].content = text
      }
      break
    }
  }
}

/** 从早期对话消息生成文本摘要（不调用 LLM，基于规则的精简提取） */
function buildHistorySummary(earlyMsgs: MessageRecord[]): string {
  const lines: string[] = []
  for (const m of earlyMsgs) {
    if (m.status !== 'done') continue
    if (m.role === 'user') {
      lines.push(`用户: ${m.content.slice(0, 200)}`)
    } else if (m.role === 'assistant') {
      // 只取 assistant 回复的前 150 字作为摘要
      const snippet = m.content.slice(0, 150).replace(/\n+/g, ' ')
      lines.push(`助手: ${snippet}${m.content.length > 150 ? '…' : ''}`)
    } else if (m.role === 'tool') {
      try {
        const tr = JSON.parse(m.content) as ToolResult
        lines.push(`工具[${tr.name}]: ${tr.content.slice(0, 80).replace(/\n+/g, ' ')}…`)
      } catch { /* skip */ }
    }
  }
  // 限制摘要总长度
  const result = lines.join('\n')
  return result.length > 1500 ? result.slice(0, 1500) + '\n…（摘要已截断）' : result
}

function buildContext(history: MessageRecord[], systemPrompt?: string): AdapterChatMessage[] {
  const out: AdapterChatMessage[] = []
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt })
  }
  let awaitingAssistant = false
  for (const m of history) {
    if (m.status !== 'done') continue
    if (m.role === 'user') {
      // 如果用户消息带附件，还原为 multimodal content
      if (m.attachments && m.attachments.length > 0) {
        const textAttachments = m.attachments.filter(a => a.type === 'text')
        const imageAttachments = m.attachments.filter(a => a.type === 'image')
        let text = m.content
        for (const ta of textAttachments) {
          text += `\n\n--- ${ta.name} ---\n${ta.data}`
        }
        if (imageAttachments.length > 0) {
          out.push({
            role: 'user',
            content: [
              { type: 'text', text },
              ...imageAttachments.map(a => ({
                type: 'image_url' as const,
                image_url: { url: a.data }
              }))
            ]
          })
        } else {
          out.push({ role: 'user', content: text })
        }
      } else {
        out.push({ role: 'user', content: m.content })
      }
      awaitingAssistant = true
    } else if (m.role === 'assistant' && awaitingAssistant) {
      const assistantMsg: AdapterChatMessage = { role: 'assistant', content: m.content }
      // 从 DB 还原 tool_calls（Agent 模式下 assistant 消息可能携带 tool_calls）
      if (m.toolCalls) {
        try {
          const parsed = JSON.parse(m.toolCalls)
          if (Array.isArray(parsed) && parsed.length > 0) {
            assistantMsg.tool_calls = parsed as ToolCall[]
          }
        } catch {
          // tool_calls 解析失败，忽略
        }
      }
      out.push(assistantMsg)
      awaitingAssistant = false
    } else if (m.role === 'tool' && out.length > 0) {
      // 还原上一轮 tool 消息
      try {
        const tr = JSON.parse(m.content) as ToolResult
        const lastAssistant = findLastAssistantWithToolCallId(out, tr.toolCallId)
        // 若没找到对应的 assistant.tool_calls，跳过该 tool 消息（避免 LLM API 报错）
        if (!lastAssistant) continue
        // 截断恢复的历史工具结果
        const truncated = tr.content.length > MAX_TOOL_RESULT_CHARS
          ? tr.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（结果已截断）'
          : tr.content
        out.push({
          role: 'tool',
          content: truncated,
          tool_call_id: tr.toolCallId,
          name: tr.name
        })
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

/** 构造审批弹窗展示内容：shell_exec 给命令全文+解析后的执行目录；其它工具给参数 JSON。
 *  逐条确认策略下（reason=REQUIRES_CONFIRM）对 shell 命令再跑一次内容分类，
 *  若属危险特征则把 reason/风险徽标升级为具体的 DANGEROUS_*，让用户看到真实风险。 */
function buildApprovalDisplay(
  tc: ToolCall,
  reason?: string
): { command: string; cwd?: string; risk: 'danger' | 'custom'; reason?: string } {
  let parsed: Record<string, unknown> = {}
  try {
    parsed = tc.function.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {}
  } catch {
    parsed = {}
  }

  if (tc.function.name === 'shell_exec') {
    const command = String(parsed.command ?? tc.function.arguments ?? '')
    // cwd 为相对工作目录的子目录；解析失败则退回工作目录根
    let cwdAbs = getWorkspaceDir() ?? undefined
    try {
      cwdAbs = resolveWorkspacePath(String(parsed.cwd ?? '.'))
    } catch {
      /* 保持工作目录根；执行阶段会再次校验 */
    }

    let risk: 'danger' | 'custom' = reason?.startsWith('DANGEROUS_') ? 'danger' : 'custom'
    let effectiveReason = reason
    if (reason === 'REQUIRES_CONFIRM') {
      const deeper = classifyCommand(command, cwdAbs ?? getWorkspaceDir() ?? process.cwd())
      if (deeper.decision === 'confirm' && deeper.reason?.startsWith('DANGEROUS_')) {
        effectiveReason = deeper.reason
        risk = 'danger'
      }
    }
    return { command, cwd: cwdAbs, risk, reason: effectiveReason }
  }

  return {
    command: JSON.stringify(parsed),
    risk: 'custom'
  }
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
    if (assistantId) {
      const assistant = assistantRepo.get(assistantId)
      effectivePrompt = assistant?.systemPrompt ?? ''
      toolPermissions = assistant?.toolPermissions ?? []
      kbIds = assistant?.knowledgeBaseIds ?? []
      skillIds = assistant?.skillIds ?? []
      defaultParams = assistant?.defaultParams ?? null
    }
    // Agent 模式必须有系统提示词引导任务拆解与工具调用；助手未配置时用默认模板
    if (!effectivePrompt || !effectivePrompt.trim()) {
      effectivePrompt = DEFAULT_AGENT_PROMPT
    }
    // Agent 模式核心是工具调用：若助手未配置工具权限，默认启用全部内置 + MCP 工具
    if (toolPermissions.length === 0) {
      toolPermissions = ['*']
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
      status: 'done',
      attachments: payload.attachments
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
    // 上下文窗口：仅保留最近 MAX_CONTEXT_MESSAGES 条历史，防止 token 溢出
    // 当历史超过 SUMMARIZE_THRESHOLD 条时，对超出窗口的早期消息生成文本摘要注入 system
    const allHistory = messageRepo.listByConversation(conversationId)
    let summaryPrefix = ''
    if (allHistory.length > SUMMARIZE_THRESHOLD) {
      const earlyMsgs = allHistory.slice(0, allHistory.length - MAX_CONTEXT_MESSAGES)
      summaryPrefix = buildHistorySummary(earlyMsgs)
    }
    const windowedHistory = allHistory.length > MAX_CONTEXT_MESSAGES
      ? allHistory.slice(-MAX_CONTEXT_MESSAGES)
      : allHistory
    const messages = buildContext(
      windowedHistory,
      summaryPrefix ? `${renderedPrompt}\n\n## 对话摘要（早期对话的精简记忆）\n${summaryPrefix}` : renderedPrompt
    )

    // 注入附件：图片→multimodal，文本→追加到用户消息
    injectAttachments(messages, payload.attachments)

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

        // 先 emit thought 占位（空文本），让前端创建消息卡片，后续 chunk 增量更新
        emit(IPC.AGENT_STEP_EVENT, {
          requestId,
          conversationId,
          stepIndex,
          type: 'thought',
          text: '',
          messageId: assistantMsg.id
        })

        // 调用 LLM
        let accumulated = ''
        let reasoningAccumulated = ''
        const adapter = providerManager.getAdapter(target.providerId)
        const chatParams: any = {
          model: target.model,
          signal: master.signal,
          maxTokens: 4096, // Agent 模式默认较大 token 上限，支持多步推理 + 工具调用
          temperature: 0.7, // 略低温度，提高工具调用确定性
          ...(defaultParams ?? {})
        }
        if (tools.length > 0) {
          chatParams.tools = tools
          chatParams.toolChoice = 'auto' // 明确指示模型可自主选择是否调用工具
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
            },
            onReasoningDelta: (delta) => {
              reasoningAccumulated += delta
              // 推送思考过程增量
              emit(IPC.AGENT_CHUNK_EVENT, {
                requestId,
                conversationId,
                stepIndex,
                messageId: assistantMsg.id,
                delta,
                reasoning: true
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
        // 持久化 tool_calls 到 DB，供恢复会话时重建上下文
        if (toolCalls && toolCalls.length > 0) {
          messageRepo.updateToolCalls(assistantMsg.id, JSON.stringify(toolCalls))
        }
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

          // 安全门：deny 硬拒 / confirm 走人工审批 / allow 直接执行
          const classification = toolRegistry.classify(
            tc.function.name,
            tc.function.arguments,
            allowedToolIds
          )

          let toolResult: ToolResult
          if (classification.decision === 'deny') {
            toolResult = {
              toolCallId: tc.id,
              name: tc.function.name,
              content: `命令被安全策略拒绝：${classification.reason ?? 'BLOCKED'}`,
              isError: true
            }
          } else if (classification.decision === 'confirm') {
            const display = buildApprovalDisplay(tc, classification.reason)
            const approved = await createApproval(
              {
                requestId,
                conversationId,
                toolName: tc.function.name,
                command: display.command,
                cwd: display.cwd,
                reason: display.reason ?? classification.reason ?? 'REQUIRES_CONFIRM',
                risk: display.risk
              },
              emit,
              master.signal
            )
            if (!approved) {
              // 用户拒绝（或审批超时/Agent 中止）：以错误结果回灌，Agent 可据此换路继续
              toolResult = {
                toolCallId: tc.id,
                name: tc.function.name,
                content: '用户拒绝执行该命令',
                isError: true
              }
            } else {
              toolResult = await this.executeWithTimeout(tc, allowedToolIds, master.signal)
            }
          } else {
            // 执行（带 30s 超时）
            toolResult = await this.executeWithTimeout(tc, allowedToolIds, master.signal)
          }

          // 持久化 tool 消息（content 存 JSON，含调用参数便于历史回放）
          const toolMsg = messageRepo.insert({
            conversationId,
            role: 'tool',
            content: JSON.stringify({
              toolCallId: toolResult.toolCallId || tc.id,
              name: toolResult.name,
              arguments: tc.function.arguments,
              content: toolResult.content,
              isError: toolResult.isError ?? false
            }),
            parentId: assistantMsg.id,
            status: 'done'
          })

          // 追加到 messages（OpenAI 格式：role=tool, content, tool_call_id, name）
          // 截断工具结果，防止长输出撑爆上下文窗口
          const truncatedResult = toolResult.content.length > MAX_TOOL_RESULT_CHARS
            ? toolResult.content.slice(0, MAX_TOOL_RESULT_CHARS) + '\n…（结果已截断，完整内容 ' + toolResult.content.length + ' 字符）'
            : toolResult.content
          const toolAdapterMsg: AdapterChatMessage = {
            role: 'tool',
            content: truncatedResult,
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
    allowedToolIds: Set<string>,
    signal: AbortSignal
  ): Promise<ToolResult> {
    const toolPromise = toolRegistry.execute(
      tc.function.name,
      tc.function.arguments,
      allowedToolIds,
      signal
    )
    // 定时器句柄保留：工具先结束时必须 clear，否则 timer 会白挂 30s（虽不产生
    // unhandledRejection，但会无谓持有 reject 闭包并推迟进程退出条件）
    let toolTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<ToolResult>((_, reject) => {
      toolTimer = setTimeout(
        () => reject(new Error(`工具 ${tc.function.name} 执行超时（${TOOL_TIMEOUT_MS / 1000}s）`)),
        TOOL_TIMEOUT_MS
      )
    })
    // Agent 中止：立即在 race 中出局（子进程由工具内 abort 监听负责杀树）
    let onAbort: (() => void) | null = null
    const abortPromise = new Promise<ToolResult>((_, reject) => {
      onAbort = () => reject(new Error('Agent 运行已中止'))
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([toolPromise, timeoutPromise, abortPromise])
    } catch (e) {
      return {
        toolCallId: tc.id,
        name: tc.function.name,
        content: `工具执行失败: ${(e as Error).message}`,
        isError: true
      }
    } finally {
      clearTimeout(toolTimer)
      // 工具先结束时摘掉 abort 监听，避免监听器泄漏
      if (onAbort) signal.removeEventListener('abort', onAbort)
    }
  }
}

export const agentEngine = new AgentEngine()
