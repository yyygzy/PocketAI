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
  AgentDoneEvent,
  AgentErrorEvent,
  ChatTarget,
  ToolCall,
  ToolResult,
  ToolSchema,
  MessageRecord
} from '../../shared/types'
import { providerManager } from '../providers/manager'
import type { AdapterChatMessage, ChatParams } from '../providers/types'
import { ProviderError } from '../providers/types'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { messageRepo } from '../db/repositories/message.repo'
import { assistantRepo } from '../db/repositories/assistant.repo'
import { agentTraceRepo } from '../db/repositories/agent-trace.repo'
import { renderPrompt } from '../assistant/prompt-template'
import { buildSkillsContext } from '../assistant/skills'
import { buildMemoryContext } from '../assistant/memory'
import { ragService } from '../knowledge/rag'
import { toolRegistry, badArgsError } from '../tools/registry'
import type { ToolAgentContext } from '../tools/builtin'
import { getWorkspaceDir, resolveWorkspacePath } from '../tools/fs-tools'
import { injectAttachments, appendTextAttachments, buildImageParts } from '../chat/context-attachments'
import { errMsg, isAbortError } from '../error'
import { createLogger } from '../logger'
import { createApproval } from './tool-approval'
import { pickSafeParams } from './safe-params'

const MAX_STEPS = 10
const logger = createLogger('agent')

/** 安全写入 trace，防止 DB 问题阻塞主流程 */
function safeTrace(rec: Parameters<typeof agentTraceRepo.insert>[0]): void {
  try {
    agentTraceRepo.insert(rec)
  } catch (e) {
    logger.warn(`[agent] trace 写入失败: ${errMsg(e)}`)
  }
}

/** 安全获取 trace 统计，表不存在时返回默认值 */
function safeTraceStats(requestId: string): { totalDurationMs: number; totalTokens: number; stepCount: number } {
  try {
    return agentTraceRepo.statsByRequest(requestId)
  } catch (e) {
    logger.warn(`[agent] trace 统计失败: ${errMsg(e)}`)
    return { totalDurationMs: 0, totalTokens: 0, stepCount: 0 }
  }
}

const REPLAN_EXTRA_STEPS = 5 // 首次超步数时重规划一次，追加的步数预算
const LOOP_TIMEOUT_MS = 5 * 60 * 1000 // 5 分钟整体超时
const TOOL_TIMEOUT_MS = 30_000 // 单个工具调用超时
const MAX_CONTEXT_MESSAGES = 30 // 上下文窗口：最多保留最近 30 条消息（不含 system），防止 token 溢出
const MAX_TOOL_RESULT_CHARS = 2000 // 工具结果在上下文中的最大字符数（截断防止撑爆 token 窗口）
const SUMMARIZE_THRESHOLD = 35 // 历史消息超过此数时，对超出窗口的部分生成摘要
const MAX_LLM_RETRIES = 2 // LLM 调用失败重试次数（网络抖动/429/5xx），不含首次
const RETRY_BASE_DELAY_MS = 1000 // 重试退避基数（指数退避：1s → 2s）
const MAX_REPEAT_TOOL_CALLS = 2 // 相同工具+参数连续调用次数阈值，超过则触发反思（防止死循环）
const PLAN_SKIP_MIN_CHARS = 30 // 单行输入不超过此长度时跳过规划阶段（问候/闲聊/一句话问答不值得多花一次 LLM 往返）

// ─── 状态机编排 ─────────────────────────────────────────────────
// Agent 运行状态：llm（调用 LLM）→ tools（执行工具）→ llm → ... → final（最终回答）
// 超步数时进入 degrade 降级。后续可扩展 reflect（反思）、route（路由）等节点。
type AgentState = 'llm' | 'tools' | 'final'

/** Agent 单次运行的共享上下文，供各状态节点读写。 */
interface AgentRunContext {
  requestId: string
  conversationId: string
  target: ChatTarget
  messages: AdapterChatMessage[]
  master: AbortController
  userMsg: MessageRecord
  tools: ToolSchema[]
  allowedToolIds: Set<string>
  defaultParams: Record<string, unknown>
  sources: Array<{ chunkId: string; docId: string; docTitle: string; content: string }>
  /** 当前助手绑定的知识库 id 列表，按次运行透传给 kb_search 工具 */
  kbIds: string[]
  emit: <T>(channel: string, payload: T) => void
  unattended: boolean
  // 运行时可变状态
  stepCount: number
  maxSteps: number // 步数预算上限（首次触顶重规划后 += REPLAN_EXTRA_STEPS）
  retriedEmpty: boolean // 空响应已重试过一次（本地小模型可能返回空 content + 空 tool_calls）
  pendingAssistantMsgId: string // 当前轮 streaming 占位消息 id（写入终态后清空），供 catch 清理避免 UI 卡「思考中」
  finalContent: string
  finalMessageId: string
  lastAssistantMsgId: string // 上一步 LLM 产出的 assistant 消息 DB id，供 tool 消息 parentId 引用
  recentToolSignatures: string[] // 最近几步工具调用签名，用于检测死循环（相同工具+参数重复调用）
}

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
- 需要查询用户知识库中的资料 → 调用 kb_search（query + 可选 top_k）
- 复杂多步任务 → 先调用 todo_write 建立任务清单，每完成一步就更新对应项状态（pending → in_progress → completed）
- 用户表达个人偏好、背景事实或要求"记住某事" → 调用 memory_save（禁止记录密码、密钥等敏感信息）
- 用户提到时间相关的提醒请求 → 先调用 time_now 确认当前时间，再调用 reminder_set；优先使用 in_minutes 相对参数
- 用户让你读写文件 → 调用 fs_list / fs_read / fs_write（需工作目录）

## 调用示例（必须严格模仿）

用户说"把结果写入 result.txt"：
❌ 错误：直接回复"已将结果写入 result.txt"——你没有真正写入，这是欺骗用户
✅ 正确：调用 fs_write 工具 → 等待工具返回结果 → 再告知用户已写入

用户问"今天几号"：
❌ 错误：凭记忆直接回答一个日期
✅ 正确：调用 time_now 工具 → 用工具返回的真实日期回答

用户问"N 天后/前是几号、星期几"：
❌ 错误：把日期字符串拼进 calculator 表达式做毫秒运算（日期字符串不是数字，必报错）
✅ 正确：调用 time_now 并传 offset_days 参数，如 100 天后 → {"offset_days": 100} → 工具直接返回目标日期与星期几

## 工具选择规则（严格遵守）
1. 查日期/时间/日期推算（N 天前后）→ 只调用 time_now（推算用 offset_days 参数），禁止用 shell_exec 或 js_eval 获取日期
2. 纯数学计算 → 只调用 calculator，禁止用 shell_exec 或 js_eval 计算
3. 写文件 → 只调用 fs_write；读文件 → 只调用 fs_read；列目录 → 只调用 fs_list
4. shell_exec 与 js_eval 仅用于以上专用工具无法覆盖的场景

## 失败处理规则
同一个工具连续失败 2 次后，禁止再尝试相同或相似操作。应换用其他工具，或直接向用户说明失败原因并给出已有结果。

## 绝对禁止
1. 禁止假装执行了操作：没有实际调用工具并得到返回结果，就不许声称"已完成/已写入/已查询到"
2. 禁止只在文本中描述"我现在将调用工具…"却不真正调用——要么立刻调用工具，要么明确说明无法完成
3. 工具返回的内容才是事实依据，最终回答必须基于工具返回的真实结果

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

{{knowledge}}

{{memory}}`

type EmitFn = (channel: string, data: unknown) => void

/**
 * 规划阶段跳过启发式（降低首响延迟：规划是首轮前的一次额外 LLM 往返）。
 * 跳过条件：
 * 1. 无可用工具 → 规划出的步骤没有工具可执行，规划无意义；
 * 2. 输入为不超过 PLAN_SKIP_MIN_CHARS 的单行文本 → 大概率是问候/闲聊/一句话问答，
 *    主提示词已含任务拆解引导，无需额外规划。
 */
export function shouldSkipPlanning(content: string, toolCount: number): boolean {
  if (toolCount === 0) return true
  const trimmed = content.trim()
  return trimmed.length < PLAN_SKIP_MIN_CHARS && !trimmed.includes('\n')
}

/**
 * 重规划提示文本：首次超步数时注入（仅内存上下文，不持久化），
 * 引导 LLM 评估进度、聚焦剩余关键步骤；任务实质完成时直接给最终回答。
 */
export function buildReplanPrompt(executedSteps: number, extraSteps: number): string {
  return `[系统提示] 已执行 ${executedSteps} 步，达到初始步数上限。请快速评估进度：哪些子任务已完成、哪些还未完成？聚焦最关键的剩余步骤继续执行（已追加 ${extraSteps} 步预算）；如果任务实质上已完成，请直接给出最终回答，不要再调用工具。`
}

// ─── Token 估算（轻量估算，无需 tokenizer 依赖） ─────────────────────────
// 估算规则：CJK 字符（汉字/假名/谚文/全角标点）≈ 1 token/字；其他（拉丁/数字/符号）≈ 4 字符/token。
// 用 token 预算替代字符截断：字符数对中文严重低估（1 字 ≈ 1 token 却按 4 字符算）、对英文高估。
const CJK_CHAR_RE = /[\u3000-\u9fff\uf900-\ufaff\uac00-\ud7af\uff00-\uffef]/
const HISTORY_USER_TOKENS = 120 // 历史摘要单条 user 消息预算
const HISTORY_ASSISTANT_TOKENS = 80 // 历史摘要单条 assistant 消息预算
const HISTORY_TOOL_TOKENS = 80 // 历史摘要普通工具结果预算
const HISTORY_LAST_TOOL_TOKENS = 600 // 历史摘要「最后一条工具结果」预算（携带后续推理依赖的状态）
const HISTORY_TOTAL_TOKENS = 1200 // 历史摘要总预算
const LLM_SUMMARY_LINE_TOKENS = 80 // LLM 摘要输入单条 user/assistant 消息预算
const LLM_SUMMARY_TOOL_TOKENS = 40 // LLM 摘要输入单条工具结果预算
const LLM_SUMMARY_INPUT_TOKENS = 1200 // LLM 摘要输入总预算

/** 估算文本 token 数：CJK ≈ 1 token/字，其他 ≈ 4 字符/token（向上取整）。 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (CJK_CHAR_RE.test(ch)) cjk++
    else other++
  }
  return cjk + Math.ceil(other / 4)
}

/**
 * 按 token 预算截断文本：预算内原样返回；超预算时二分查找最大前缀（确定性），
 * 截断后追加 '…'（为省略号预留 1 token）。
 */
export function cutToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (estimateTokens(text) <= maxTokens) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (estimateTokens(text.slice(0, mid)) + 1 <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return text.slice(0, lo) + '…'
}

/**
 * 从早期对话消息生成文本摘要（不调用 LLM，基于规则的精简提取）。
 * 优化：保留早期消息中「最后一条工具结果」较完整内容（最多 HISTORY_LAST_TOOL_TOKENS），
 * 因为它通常携带后续推理依赖的状态；其余内容按 token 预算截断，防止 token 溢出。
 */
export function buildHistorySummary(earlyMsgs: MessageRecord[]): string {
  const lines: string[] = []
  // 定位早期消息中最后一条 tool 消息的索引，用于保留完整结果
  let lastToolIdx = -1
  for (let i = earlyMsgs.length - 1; i >= 0; i--) {
    const m = earlyMsgs[i]
    if (!m) continue
    if (m.status === 'done' && m.role === 'tool') {
      lastToolIdx = i
      break
    }
  }
  for (let i = 0; i < earlyMsgs.length; i++) {
    const m = earlyMsgs[i]
    if (!m) continue
    if (m.status !== 'done') continue
    if (m.role === 'user') {
      lines.push(`用户: ${cutToTokens(m.content, HISTORY_USER_TOKENS)}`)
    } else if (m.role === 'assistant') {
      lines.push(`助手: ${cutToTokens(m.content.replace(/\n+/g, ' '), HISTORY_ASSISTANT_TOKENS)}`)
    } else if (m.role === 'tool') {
      try {
        const tr = JSON.parse(m.content) as ToolResult
        // 最后一条工具结果保留较完整内容（HISTORY_LAST_TOOL_TOKENS），其余截断
        const limit = i === lastToolIdx ? HISTORY_LAST_TOOL_TOKENS : HISTORY_TOOL_TOKENS
        lines.push(`工具[${tr.name}]: ${cutToTokens(tr.content.replace(/\n+/g, ' '), limit)}`)
      } catch { /* skip */ }
    }
  }
  // 限制摘要总 token 预算
  return cutToTokens(lines.join('\n'), HISTORY_TOTAL_TOKENS)
}

/**
 * 用 LLM 生成对话历史摘要，失败/超时时降级为规则摘要。
 * 输入限制在 LLM_SUMMARY_INPUT_TOKENS 内避免 token 溢出，输出限制 800 token。
 */
async function summarizeHistoryWithLLM(
  earlyMsgs: MessageRecord[],
  adapter: ReturnType<typeof providerManager.getAdapter>,
  model: string,
  signal: AbortSignal
): Promise<string> {
  // 把早期消息压缩为简短文本（每条按 token 预算截断），作为摘要输入
  const lines: string[] = []
  for (const m of earlyMsgs) {
    if (!m || m.status !== 'done') continue
    if (m.role === 'user') lines.push(`用户: ${cutToTokens(m.content, LLM_SUMMARY_LINE_TOKENS)}`)
    else if (m.role === 'assistant') lines.push(`助手: ${cutToTokens(m.content, LLM_SUMMARY_LINE_TOKENS)}`)
    else if (m.role === 'tool') lines.push(`工具结果: ${cutToTokens(m.content, LLM_SUMMARY_TOOL_TOKENS)}`)
  }
  const input = cutToTokens(lines.join('\n'), LLM_SUMMARY_INPUT_TOKENS)
  const prompt = `请简要总结以下对话历史，保留关键信息：用户的核心需求、已执行的工具调用及重要结果、达成的结论。用简洁的中文，不超过 300 字。\n\n${input}`

  try {
    const result = await adapter.streamChat(
      [{ role: 'user', content: prompt }],
      { model, signal, maxTokens: 800, temperature: 0.3 },
      { onDelta: () => {} }
    )
    const summary = (result.content || '').trim()
    return summary || buildHistorySummary(earlyMsgs)
  } catch {
    // LLM 摘要失败（网络/离线/超时）：降级为规则摘要
    return buildHistorySummary(earlyMsgs)
  }
}

export function buildContext(history: MessageRecord[], systemPrompt?: string): AdapterChatMessage[] {
  const out: AdapterChatMessage[] = []
  if (systemPrompt && systemPrompt.trim()) {
    out.push({ role: 'system', content: systemPrompt })
  }
  // 预收集历史中已被 tool 消息应答过的 toolCallId：
  // assistant.tool_calls 中没有对应 tool 结果的调用（中止/出错时的残留）必须剥离，
  // 否则严格 OpenAI 兼容端会因「tool_calls 未被应答」直接报 400。
  const answeredToolCallIds = new Set<string>()
  for (const m of history) {
    if (m.role !== 'tool' || m.status !== 'done') continue
    try {
      const tr = JSON.parse(m.content) as ToolResult
      if (tr?.toolCallId) answeredToolCallIds.add(tr.toolCallId)
    } catch { /* 老消息格式，跳过 */ }
  }
  // 找到最后一条带图片的 user 消息索引：只有它需要携带 base64，
  // 更早的图片已在对应 assistant 回复中被 LLM 处理过，用文本占位避免多轮重复消耗 token。
  let lastImageUserIdx = -1
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i]!
    if (m.role === 'user' && m.attachments?.some((a) => a.type === 'image')) {
      lastImageUserIdx = i
      break
    }
  }

  let awaitingAssistant = false
  for (let idx = 0; idx < history.length; idx++) {
    const m = history[idx]!
    if (m.status !== 'done') continue
    if (m.role === 'user') {
      // 如果用户消息带附件，还原为 multimodal content
      if (m.attachments && m.attachments.length > 0) {
        const textAttachments = m.attachments.filter(a => a.type === 'text')
        const imageAttachments = m.attachments.filter(a => a.type === 'image')
        const text = appendTextAttachments(m.content, textAttachments)
        // 仅最后一条带图消息携带 base64；更早的图片用占位符引用，避免每轮重复发送
        if (imageAttachments.length > 0 && idx === lastImageUserIdx) {
          out.push({ role: 'user', content: buildImageParts(text, imageAttachments) })
        } else if (imageAttachments.length > 0) {
          // 非最新图片：用文本占位（已在更早的回复中被处理）
          const placeholders = imageAttachments.map(a => `[图片: ${a.name}]`).join('、')
          out.push({ role: 'user', content: `${text}\n\n_${placeholders}（图片已在之前的回复中处理，此处省略原始数据以节省 token）_` })
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
            // 仅保留有 tool 结果应答的调用，剥离中止/失败残留的悬空 tool_calls
            const answered = (parsed as ToolCall[]).filter((tc) => answeredToolCallIds.has(tc.id))
            if (answered.length > 0) {
              assistantMsg.tool_calls = answered
            }
          }
        } catch {
          // tool_calls 解析失败，忽略
        }
      }
      out.push(assistantMsg)
      awaitingAssistant = false
    } else if (m.role === 'tool' && out.length > 0) {
      // 工具结果之后的 assistant 消息是同轮 ReAct 推理的延续，必须进上下文
      awaitingAssistant = true
      // 还原上一轮 tool 消息
      try {
        const tr = JSON.parse(m.content) as ToolResult
        const lastAssistant = findLastAssistantWithToolCallId(out, tr.toolCallId)
        // 若没找到对应的 assistant.tool_calls，跳过该 tool 消息（避免 LLM API 报错）
        if (!lastAssistant) continue
        // 压缩恢复的历史工具结果
        const truncated = compressToolResult(tr.content, MAX_TOOL_RESULT_CHARS)
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
    if (!m) continue
    if (m.role === 'assistant' && m.tool_calls?.some((tc: ToolCall) => tc.id === toolCallId)) {
      return m
    }
  }
  return null
}

/** 计算一组 tool_calls 的确定性签名（按工具名排序后拼接 name:arguments），
 *  用于检测死循环：相同工具+相同参数重复调用。 */
export function computeToolSignature(toolCalls: ToolCall[]): string {
  return toolCalls
    .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
    .sort()
    .join('|')
}

/** 工具结果智能压缩：超长时保留关键信息而非简单截断。
 *  - JSON 数组：保留长度 + 前 3 项 + 末尾摘要
 *  - JSON 对象：保留所有键名 + 前几行值
 *  - 纯文本：保留首段 + 末段
 */
export function compressToolResult(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content
  // 尝试 JSON 结构化压缩
  const trimmed = content.trim()
  if ((trimmed.startsWith('[') || trimmed.startsWith('{'))) {
    try {
      const parsed = JSON.parse(trimmed)
      if (Array.isArray(parsed)) {
        const head = JSON.stringify(parsed.slice(0, 3), null, 2)
        return `${head}\n…（数组共 ${parsed.length} 项，仅显示前 3 项，完整 ${content.length} 字符）`
      }
      if (parsed && typeof parsed === 'object') {
        const keys = Object.keys(parsed)
        const summary = keys.length > 20
          ? `对象包含 ${keys.length} 个字段：${keys.slice(0, 15).join(', ')}…等`
          : `对象字段：${keys.join(', ')}`
        const head = JSON.stringify(parsed, null, 2).slice(0, Math.floor(maxChars * 0.7))
        return `${head}\n…（${summary}，完整 ${content.length} 字符）`
      }
    } catch {
      // 非合法 JSON，走纯文本压缩
    }
  }
  // 纯文本：保留首段 + 末段
  const headLen = Math.floor(maxChars * 0.6)
  const tailLen = maxChars - headLen - 50
  const head = content.slice(0, headLen)
  const tail = content.slice(-tailLen)
  return `${head}\n…（中间已省略，完整 ${content.length} 字符）\n${tail}`
}

/** 构造审批弹窗展示内容：shell_exec 给命令全文+解析后的执行目录；其它工具给参数 JSON。
 *  classification.reason 已由 classifyShellArgs 保留 classifyCommand 的具体危险原因，
 *  此处直接复用，不再重复调用 classifyCommand。 */
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

    const risk: 'danger' | 'custom' = reason?.startsWith('DANGEROUS_') ? 'danger' : 'custom'
    return { command, cwd: cwdAbs, risk, reason }
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
    const { requestId, conversationId, content, assistantId, targets, unattended } = payload
    if (!targets || targets.length === 0) throw new Error('未选择模型')
    const target: ChatTarget = targets[0]! // Agent 模式只取第一个目标（length 已校验）

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
    let sources: Array<{ chunkId: string; docId: string; docTitle: string; content: string }> = []
    if (effectivePrompt.includes('{{knowledge}}') && kbIds.length > 0) {
      try {
        const result = await ragService.retrieve(kbIds, content)
        knowledgeContext = ragService.buildContext(result.chunks)
        sources = result.chunks.map((c) => ({
          chunkId: c.chunkId,
          docId: c.docId,
          docTitle: c.docTitle,
          content: c.content
        }))
      } catch {
        // 检索失败不阻断
      }
    }

    // 工具 schema 与 {{tools}}
    const tools = toolRegistry.filterByPermissions(toolPermissions)
    const toolsText = toolRegistry.formatForPrompt(tools)

    const skillsContext = buildSkillsContext(skillIds)
    const memoryContext = buildMemoryContext()
    const renderedPrompt = renderPrompt(effectivePrompt, {
      knowledge: knowledgeContext,
      tools: toolsText,
      skills: skillsContext,
      memory: memoryContext
    })

    // 持久化用户消息
    const userMsg = messageRepo.insert({
      conversationId,
      role: 'user',
      content,
      status: 'done',
      attachments: payload.attachments
    })
    // 回传用户消息 DB id，渲染端本地占位卡（u_xxx）据此获得可删除的 dbId
    emit(IPC.AGENT_STEP_EVENT, {
      requestId,
      conversationId,
      stepIndex: 0,
      type: 'user',
      messageId: userMsg.id
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
      // 优先用 LLM 生成高质量摘要，失败/超时降级为规则摘要
      const summaryAdapter = providerManager.getAdapter(target.providerId)
      summaryPrefix = await summarizeHistoryWithLLM(
        earlyMsgs,
        summaryAdapter,
        target.model,
        master.signal
      )
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

    // 显式规划阶段（Plan-and-Execute）：
    // 首轮对话（无历史工具调用）先让 LLM 输出执行计划，注入 system prompt 引导后续执行。
    // 规划失败不阻塞主流程；简单任务模型会输出"无需计划"。
    // 无工具/短单行输入时跳过规划（shouldSkipPlanning），避免白付一次 LLM 往返。
    let planText = ''
    const hasToolHistory = messages.some(
      (m) => m.role === 'tool' || (m.role === 'assistant' && m.tool_calls?.length)
    )
    if (!hasToolHistory && !shouldSkipPlanning(content, tools.length)) {
      try {
        const planAdapter = providerManager.getAdapter(target.providerId)
        const planSystem = `你是一个任务规划助手。请分析用户的最新请求，制定简洁的执行计划。
要求：
1. 用数字编号列出步骤（1. 2. 3. ...），每步不超过 20 字
2. 简单任务（问好、闲聊、一句话可答）输出"无需计划"
3. 只输出计划本身，不要额外解释`
        const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user')
        const planMessages: AdapterChatMessage[] = [{ role: 'system', content: planSystem }]
        if (lastUserMsg) planMessages.push(lastUserMsg)

        const planResult = await planAdapter.streamChat(
          planMessages,
          {
            model: target.model,
            signal: master.signal,
            maxTokens: 512,
            temperature: 0.3
          },
          { onDelta: () => {} }
        )
        planText = (planResult.content || '').trim()
      } catch {
        // 规划失败不阻塞主流程，降级为无计划模式
      }
    }

    // 将计划注入 system prompt，引导后续 ReAct 循环按计划执行
    if (planText && planText !== '无需计划') {
      const planInjection = `\n\n## 执行计划\n${planText}\n\n请按以上计划逐步执行，每步可调用工具获取中间结果，全部完成后给出最终回答。`
      const sysMsg = messages.find((m) => m.role === 'system')
      if (sysMsg && typeof sysMsg.content === 'string') {
        sysMsg.content += planInjection
      }
      // emit 计划到前端展示（stepIndex=0，不持久化到 DB，避免污染对话历史）
      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex: 0,
        type: 'thought',
        text: `**执行计划**\n${planText}`
      })
    }

    // 状态机上下文：封装所有跨节点共享的可变状态
    const ctx: AgentRunContext = {
      requestId,
      conversationId,
      target,
      messages,
      master,
      userMsg,
      tools,
      allowedToolIds,
      defaultParams: defaultParams ?? {},
      sources,
      kbIds,
      emit,
      unattended: unattended ?? false,
      stepCount: 0,
      maxSteps: MAX_STEPS,
      retriedEmpty: false,
      pendingAssistantMsgId: '',
      finalContent: '',
      finalMessageId: '',
      lastAssistantMsgId: '',
      recentToolSignatures: []
    }

    try {
      // 状态机驱动：llm → tools → llm → ... → final
      // 首次触顶（stepCount >= maxSteps）时注入重规划提示并追加步数预算继续执行；
      // 再次触顶才跳出循环进入 degrade 降级
      let state: AgentState = 'llm'
      let replanned = false
      while (state !== 'final') {
        if (ctx.master.signal.aborted) throw new Error('Agent 运行已中止')
        if (ctx.stepCount >= ctx.maxSteps) {
          if (replanned) break
          replanned = true
          this.runReplanStep(ctx)
          continue
        }

        ctx.stepCount++
        const stepIndex = ctx.stepCount

        if (state === 'llm') {
          state = await this.runLLMStep(ctx, stepIndex)
        } else {
          state = await this.runToolsStep(ctx, stepIndex)
        }
      }

      // 超步数降级：再调一次 LLM（不带 tools）强制生成最终回答
      if (state !== 'final') {
        const degradeOk = await this.runDegradeStep(ctx)
        if (!degradeOk) {
          // 降级失败时 runDegradeStep 内已 emit 错误事件并更新会话状态，
          // 此处直接结束，不再发 DONE 事件（避免 error+done 双事件、状态被 done 覆盖）
          return
        }
      }

      const doneEvt: AgentDoneEvent = {
        requestId,
        conversationId,
        finalMessageId: ctx.finalMessageId,
        fullContent: ctx.finalContent,
        stepCount: ctx.stepCount,
        traceStats: safeTraceStats(requestId)
      }
      emit(IPC.AGENT_DONE_EVENT, doneEvt)
      conversationRepo.touch(conversationId, { status: 'done' })
    } catch (e) {
      const aborted = isAbortError(e) || /中止/.test(errMsg(e))
      const errText = aborted ? 'Agent 运行已中止' : errMsg(e)
      // 清理流式占位消息：错误/中止时把当前轮 assistant 占位写入终态并同步 UI，
      // 否则渲染端消息卡永远显示「思考中…」（只清 pending，不覆盖已完成消息）
      if (ctx.pendingAssistantMsgId) {
        const pendingId = ctx.pendingAssistantMsgId
        ctx.pendingAssistantMsgId = ''
        const noticeText = aborted ? '（已中止）' : `（出错：${errText}）`
        try {
          messageRepo.updateContent(pendingId, noticeText, aborted ? 'aborted' : 'error')
          emit(IPC.AGENT_STEP_EVENT, {
            requestId,
            conversationId,
            stepIndex: ctx.stepCount,
            type: 'thought',
            text: noticeText,
            messageId: pendingId
          })
        } catch (cleanupErr) {
          logger.warn(`清理占位消息失败: ${errMsg(cleanupErr)}`)
        }
      }
      const errEvt: AgentErrorEvent = { requestId, conversationId, error: errText }
      emit(IPC.AGENT_ERROR_EVENT, errEvt)
      conversationRepo.touch(conversationId, { status: aborted ? 'aborted' : 'error' })
    } finally {
      clearTimeout(loopTimer)
      this.controllers.delete(requestId)
    }
  }

  // ─── 状态机节点方法 ────────────────────────────────────────────

  /**
   * LLM 调用节点：流式调用模型，持久化 assistant 消息，emit thought 事件。
   * 返回下一个状态：有 tool_calls → 'tools'，无 → 'final'。
   * 失败时抛错（由外层 catch 处理）。
   */
  private async runLLMStep(ctx: AgentRunContext, stepIndex: number): Promise<AgentState> {
    const { conversationId, target, messages, master, userMsg, tools, defaultParams, sources, emit } = ctx
    const stepStart = Date.now()

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

    // 记录本轮 assistant 消息 id，供后续 tool 消息 parentId 引用
    ctx.lastAssistantMsgId = assistantMsg.id
    // 标记当前 streaming 占位，catch 清理时只处理它（不覆盖已完成的上一轮消息）
    ctx.pendingAssistantMsgId = assistantMsg.id

    // 先 emit thought 占位（空文本），让前端创建消息卡片，后续 chunk 增量更新
    emit(IPC.AGENT_STEP_EVENT, {
      requestId: ctx.requestId,
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
    const chatParams: ChatParams = {
      model: target.model,
      signal: master.signal,
      maxTokens: 4096,
      temperature: 0.7,
      ...pickSafeParams(defaultParams)
    }
    if (tools.length > 0) {
      chatParams.tools = tools
      chatParams.toolChoice = 'auto'
    }

    // 调用 LLM（带重试）
    let result: Awaited<ReturnType<typeof adapter.streamChat>> | undefined
    let llmError: unknown
    for (let attempt = 0; attempt <= MAX_LLM_RETRIES; attempt++) {
      if (master.signal.aborted) throw new Error('Agent 运行已中止')
      if (attempt > 0) {
        accumulated = ''
        reasoningAccumulated = ''
        emit(IPC.AGENT_STEP_EVENT, {
          requestId: ctx.requestId,
          conversationId,
          stepIndex,
          type: 'thought',
          text: '',
          messageId: assistantMsg.id
        })
      }
      try {
        logger.info(`[agent] step=${stepIndex} 调用 streamChat...`)
        result = await adapter.streamChat(messages, chatParams, {
          onDelta: (delta) => {
            accumulated += delta
            emit(IPC.AGENT_CHUNK_EVENT, {
              requestId: ctx.requestId,
              conversationId,
              stepIndex,
              messageId: assistantMsg.id,
              delta
            })
          },
          onReasoningDelta: (delta) => {
            reasoningAccumulated += delta
            emit(IPC.AGENT_CHUNK_EVENT, {
              requestId: ctx.requestId,
              conversationId,
              stepIndex,
              messageId: assistantMsg.id,
              delta,
              reasoning: true
            })
          }
        })
        break
      } catch (e) {
        logger.debug(`streamChat 失败 step=${stepIndex}: ${errMsg(e)}`)
        if (isAbortError(e)) throw e
        const retryable =
          (e instanceof ProviderError && e.retryable) || !(e instanceof ProviderError)
        if (!retryable || attempt >= MAX_LLM_RETRIES) {
          llmError = e
          break
        }
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay)
          master.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              resolve()
            },
            { once: true }
          )
        })
        if (master.signal.aborted) throw new Error('Agent 运行已中止')
      }
    }

    if (!result) {
      const e = llmError
      const partial = accumulated || `_(LLM 调用失败: ${errMsg(e)})_`
      messageRepo.updateContent(assistantMsg.id, partial, 'error')
      emit(IPC.AGENT_STEP_EVENT, {
        requestId: ctx.requestId,
        conversationId,
        stepIndex,
        type: 'error',
        error: errMsg(e),
        messageId: assistantMsg.id
      })
      // trace：LLM 步骤失败
      safeTrace({
        requestId: ctx.requestId,
        conversationId,
        stepIndex,
        stepType: 'llm',
        durationMs: Date.now() - stepStart,
        status: 'error',
        error: errMsg(e)
      })
      throw e
    }

    // 写入本步 assistant 文本
    const toolCalls = result.toolCalls
    const tokenUsage = result.usage?.totalTokens
    const rawText = result.content || ''
    logger.info(`[agent] step=${stepIndex} 进入后处理 toolCalls=${toolCalls?.length ?? 0}`)
    const truncated = result.finishReason === 'length' && (!toolCalls || toolCalls.length === 0)
    let stepText = truncated
      ? `${rawText}\n\n_（回答因达到 token 上限被截断，如需完整内容请继续追问）_`
      : rawText

    // 空响应防御：本地小模型可能返回空 content + 空 tool_calls。
    // 首次：占位消息标记「重试中」并注入提示重跑一轮 llm；重试后仍空：写兜底文案正常结束。
    if (!stepText.trim() && (!toolCalls || toolCalls.length === 0)) {
      if (!ctx.retriedEmpty) {
        logger.info(`[agent] step=${stepIndex} 空响应，触发重试`)
        ctx.retriedEmpty = true
        const retryText = '（模型返回空内容，正在重试…）'
        messageRepo.updateContent(assistantMsg.id, retryText, 'done')
        ctx.pendingAssistantMsgId = '' // 占位已写终态
        messages.push({ role: 'assistant', content: retryText })
        messages.push({
          role: 'user',
          content: '[系统提示] 你的上一条回复为空。请直接回答用户的问题，或调用合适的工具获取信息。'
        })
        emit(IPC.AGENT_STEP_EVENT, {
          requestId: ctx.requestId,
          conversationId,
          stepIndex,
          type: 'thought',
          text: retryText,
          messageId: assistantMsg.id
        })
        safeTrace({
          requestId: ctx.requestId,
          conversationId,
          stepIndex,
          stepType: 'llm',
          durationMs: Date.now() - stepStart,
          tokenUsage,
          status: 'error',
          error: 'empty_response'
        })
        return 'llm'
      }
      stepText = '（模型未返回内容，请重试或更换模型）'
    }

    messageRepo.updateContent(assistantMsg.id, stepText, 'done', !toolCalls || toolCalls.length === 0 ? sources : undefined)
    ctx.pendingAssistantMsgId = '' // 占位已写终态

    if (toolCalls && toolCalls.length > 0) {
      logger.info(`[agent] step=${stepIndex} 写入 toolCalls`)
      messageRepo.updateToolCalls(assistantMsg.id, JSON.stringify(toolCalls))
      logger.info(`[agent] step=${stepIndex} toolCalls 写入完成`)
    }
    messages.push({
      role: 'assistant',
      content: stepText,
      ...(toolCalls && toolCalls.length > 0 ? { tool_calls: toolCalls } : {})
    })
    logger.info(`[agent] step=${stepIndex} messages.push 完成`)

    emit(IPC.AGENT_STEP_EVENT, {
      requestId: ctx.requestId,
      conversationId,
      stepIndex,
      type: 'thought',
      text: stepText,
      messageId: assistantMsg.id
    })
    logger.info(`[agent] step=${stepIndex} emit thought 完成`)

    // 无 tool_calls → 最终回答
    if (!toolCalls || toolCalls.length === 0) {
      ctx.finalContent = stepText
      ctx.finalMessageId = assistantMsg.id
      emit(IPC.AGENT_STEP_EVENT, {
        requestId: ctx.requestId,
        conversationId,
        stepIndex,
        type: 'final',
        text: stepText,
        messageId: assistantMsg.id,
        done: true
      })
      // trace：LLM 步骤成功（最终回答）
      safeTrace({
        requestId: ctx.requestId,
        conversationId,
        stepIndex,
        stepType: 'final',
        durationMs: Date.now() - stepStart,
        tokenUsage,
        status: 'success'
      })
      return 'final'
    }

    // trace：LLM 步骤成功（产出工具调用）
    logger.info(`[agent] step=${stepIndex} 准备写入 trace`)
    safeTrace({
      requestId: ctx.requestId,
      conversationId,
      stepIndex,
      stepType: 'llm',
      durationMs: Date.now() - stepStart,
      tokenUsage,
      status: 'success'
    })
    logger.info(`[agent] step=${stepIndex} trace 写入完成，返回 tools`)
    return 'tools'
  }

  /**
   * 工具执行节点：分类执行 tool_calls（deny/confirm/allow），
   * allow 类并行执行，结果按原顺序持久化与 emit。
   * 返回下一个状态：'llm'。
   */
  private async runToolsStep(ctx: AgentRunContext, stepIndex: number): Promise<AgentState> {
    const { conversationId, messages, master, allowedToolIds, emit, unattended, requestId, kbIds } = ctx
    const stepStart = Date.now()
    logger.info(`[agent] step=${stepIndex} 进入 runToolsStep, messages=${messages.length}`)
    // 运行级上下文片段：透传给需要向渲染端发事件的内置工具（todo_write）
    const agentCtx: ToolAgentContext = { requestId, conversationId, emit, stepIndex }

    // 获取上一步 LLM 返回的 tool_calls（从 messages 最后一条 assistant 消息取）
    const lastAssistant = messages[messages.length - 1]
    const toolCalls = lastAssistant?.tool_calls
    if (!toolCalls || toolCalls.length === 0) return 'llm'

    // 死循环检测：相同工具+参数连续调用超过阈值时，注入反思引导而非重复执行
    const signature = computeToolSignature(toolCalls)
    const repeatCount = ctx.recentToolSignatures.filter((s) => s === signature).length
    if (repeatCount >= MAX_REPEAT_TOOL_CALLS) {
      const toolList = Array.from(new Set(toolCalls.map((tc) => tc.function.name))).join('、')
      messages.push({
        role: 'user',
        content: `检测到你连续 ${repeatCount + 1} 次调用了相同的工具（${toolList}）和参数，但结果未达预期。
请停下来反思：
1. 这个工具是否真的能解决当前问题？
2. 是否需要更换工具或调整参数？
3. 是否可以直接基于已有信息给出回答？
请不要重复相同的调用，换一种方式继续。`
      })
      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex,
        type: 'thought',
        text: `_（检测到工具重复调用，已引导 Agent 反思调整策略）_`
      })
      safeTrace({
        requestId: ctx.requestId,
        conversationId,
        stepIndex,
        stepType: 'tools',
        toolName: toolList,
        durationMs: Date.now() - stepStart,
        status: 'error',
        error: `重复工具调用已拦截：${signature}`
      })
      return 'llm'
    }
    // 记录本步签名，仅保留最近 MAX_REPEAT_TOOL_CALLS 条用于连续重复判断
    ctx.recentToolSignatures.push(signature)
    if (ctx.recentToolSignatures.length > MAX_REPEAT_TOOL_CALLS) {
      ctx.recentToolSignatures.shift()
    }

    // 分类执行
    const classifications = toolCalls.map((tc) =>
      toolRegistry.classify(tc.function.name, tc.function.arguments, allowedToolIds)
    )

    const results: ToolResult[] = new Array(toolCalls.length)
    const allowTasks: Promise<void>[] = []

    for (let i = 0; i < toolCalls.length; i++) {
      if (master.signal.aborted) throw new Error('Agent 运行已中止')
      const tc = toolCalls[i]!
      const classification = classifications[i]!

      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex,
        type: 'tool_call',
        toolCall: tc
      })

      if (classification.decision === 'deny') {
        // BAD_ARGS（参数 JSON 解析失败）走富文本错误，命中下方修正引导注入；
        // 其余 deny 原因按安全策略拒绝处理。
        results[i] = classification.reason === 'BAD_ARGS'
          ? {
              toolCallId: tc.id,
              name: tc.function.name,
              content: badArgsError(tc.function.arguments, 'JSON 格式非法（已被安全策略拦截）'),
              isError: true
            }
          : {
              toolCallId: tc.id,
              name: tc.function.name,
              content: `命令被安全策略拒绝：${classification.reason ?? 'BLOCKED'}`,
              isError: true
            }
      } else if (classification.decision === 'confirm') {
        if (unattended) {
          results[i] = {
            toolCallId: tc.id,
            name: tc.function.name,
            content: `工具 ${tc.function.name} 需人工确认，但当前为无人值守场景，请在桌面端操作`,
            isError: true
          }
        } else {
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
            results[i] = {
              toolCallId: tc.id,
              name: tc.function.name,
              content: '用户拒绝执行该命令',
              isError: true
            }
          } else {
            results[i] = await this.executeWithTimeout(tc, allowedToolIds, master.signal, kbIds, agentCtx)
          }
        }
      } else {
        const idx = i
        allowTasks.push(
          this.executeWithTimeout(tc, allowedToolIds, master.signal, kbIds, agentCtx).then((r) => {
            results[idx] = r
          })
        )
      }
    }

    await Promise.all(allowTasks)

    // 按原顺序持久化 + push messages + emit tool_result
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i]!
      const toolResult = results[i]!

      // 持久化 tool 消息，parentId 指向上一步 assistant 消息
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
        parentId: ctx.lastAssistantMsgId,
        status: 'done'
      })

      const truncatedResult = compressToolResult(toolResult.content, MAX_TOOL_RESULT_CHARS)
      messages.push({
        role: 'tool',
        content: truncatedResult,
        tool_call_id: tc.id,
        name: tc.function.name
      })

      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex,
        type: 'tool_result',
        toolResult: { ...toolResult, toolCallId: tc.id },
        messageId: toolMsg.id
      })
    }

    // BAD_ARGS 自动修正引导
    const hasBadArgs = results.some(
      (r) => r?.isError && r.content.startsWith('[BAD_ARGS]')
    )
    if (hasBadArgs) {
      messages.push({
        role: 'user',
        content: '上一步工具调用因参数 JSON 格式错误而失败。请仔细检查参数格式（注意引号、逗号、括号必须正确），使用正确的 JSON 格式重新调用该工具，不要重复使用错误的参数。'
      })
    }

    // trace：工具执行步骤（记录工具名列表与是否有错误）
    const toolNames = toolCalls.map((tc) => tc.function.name).join(',')
    const hasError = results.some((r) => r?.isError)
    safeTrace({
      requestId: ctx.requestId,
      conversationId,
      stepIndex,
      stepType: 'tools',
      toolName: toolNames,
      durationMs: Date.now() - stepStart,
      status: hasError ? 'error' : 'success',
      error: hasError ? results.find((r) => r?.isError)?.content : undefined
    })

    return 'llm'
  }

  /**
   * 重规划节点（同步，无 LLM 调用）：首次超步数时注入重规划提示到内存上下文、
   * 追加步数预算、emit replan 事件（渲染端显示提示条）、记 trace。
   */
  private runReplanStep(ctx: AgentRunContext): void {
    ctx.maxSteps += REPLAN_EXTRA_STEPS
    ctx.messages.push({ role: 'user', content: buildReplanPrompt(ctx.stepCount, REPLAN_EXTRA_STEPS) })
    ctx.emit(IPC.AGENT_STEP_EVENT, {
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
      stepIndex: ctx.stepCount,
      type: 'replan',
      text: `已达步数上限，正在评估进度并重新规划（追加 ${REPLAN_EXTRA_STEPS} 步预算）…`
    })
    safeTrace({
      requestId: ctx.requestId,
      conversationId: ctx.conversationId,
      stepIndex: ctx.stepCount,
      stepType: 'replan',
      durationMs: 0,
      status: 'success'
    })
  }

  /**
   * 降级节点：超步数时再调一次 LLM（不带 tools）强制生成最终回答。
   * 成功返回 true；失败时内部已 trace + emit 错误事件 + 更新会话状态，返回 false，
   * 由调用方直接结束（不再发 DONE 事件）。
   */
  private async runDegradeStep(ctx: AgentRunContext): Promise<boolean> {
    const { conversationId, target, messages, master, userMsg, defaultParams, emit, requestId } = ctx
    const stepStart = Date.now()

    try {
      const degradeMsg = messageRepo.insert({
        conversationId,
        role: 'assistant',
        content: '',
        provider: target.providerId,
        model: target.model,
        status: 'streaming',
        parentId: userMsg.id
      })
      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex: ctx.stepCount + 1,
        type: 'thought',
        text: '',
        messageId: degradeMsg.id
      })

      messages.push({
        role: 'user',
        content: `已达到最大推理步数（${ctx.maxSteps} 步）。请基于上面已有的工具调用结果和对话信息，直接给出最终回答，不要再调用任何工具。`
      })

      const degradeAdapter = providerManager.getAdapter(target.providerId)
      const degradeParams: ChatParams = {
        model: target.model,
        signal: master.signal,
        maxTokens: 2048,
        temperature: 0.3,
        ...pickSafeParams(defaultParams)
      }

      let degradeAccumulated = ''
      const degradeResult = await degradeAdapter.streamChat(messages, degradeParams, {
        onDelta: (delta) => {
          degradeAccumulated += delta
          emit(IPC.AGENT_CHUNK_EVENT, {
            requestId,
            conversationId,
            stepIndex: ctx.stepCount + 1,
            messageId: degradeMsg.id,
            delta
          })
        }
      })

      const degradeText = degradeResult.content || '（已达最大推理步数，未能生成最终回答）'
      const finalText = degradeResult.finishReason === 'length'
        ? `${degradeText}\n\n_（回答因达到 token 上限被截断）_`
        : degradeText
      messageRepo.updateContent(degradeMsg.id, finalText, 'done')

      ctx.finalContent = finalText
      ctx.finalMessageId = degradeMsg.id

      emit(IPC.AGENT_STEP_EVENT, {
        requestId,
        conversationId,
        stepIndex: ctx.stepCount + 1,
        type: 'final',
        text: finalText,
        messageId: degradeMsg.id,
        done: true
      })
      // trace：降级步骤成功
      safeTrace({
        requestId: ctx.requestId,
        conversationId,
        stepIndex: ctx.stepCount + 1,
        stepType: 'degrade',
        durationMs: Date.now() - stepStart,
        tokenUsage: degradeResult.usage?.totalTokens,
        status: 'success'
      })
      return true
    } catch (e) {
      const aborted = isAbortError(e) || /中止/.test(errMsg(e))
      // trace：降级步骤失败
      safeTrace({
        requestId: ctx.requestId,
        conversationId,
        stepIndex: ctx.stepCount + 1,
        stepType: 'degrade',
        durationMs: Date.now() - stepStart,
        status: 'error',
        error: errMsg(e)
      })
      emit(IPC.AGENT_ERROR_EVENT, {
        requestId,
        conversationId,
        error: aborted
          ? 'Agent 运行已中止'
          : `已达最大推理步数（${MAX_STEPS}），且降级总结失败：${errMsg(e)}`
      })
      conversationRepo.touch(conversationId, { status: aborted ? 'aborted' : 'error' })
      return false
    }
  }

  // ─── 原有辅助方法 ──────────────────────────────────────────────

  private async executeWithTimeout(
    tc: ToolCall,
    allowedToolIds: Set<string>,
    signal: AbortSignal,
    kbIds?: string[],
    agent?: ToolAgentContext
  ): Promise<ToolResult> {
    // 子控制器：超时或 Agent 中止时主动 abort，让底层工具（shell 进程树、MCP 请求、
    // 网络请求等）及时清理，避免 Promise.race 超时后底层进程继续悬空运行。
    const subController = new AbortController()
    if (signal.aborted) subController.abort()

    const toolPromise = toolRegistry.execute(
      tc.function.name,
      tc.function.arguments,
      allowedToolIds,
      subController.signal,
      kbIds,
      agent
    )
    // 按工具 schema 配置的 timeoutMs 决定超时；未配置时使用默认 30s。
    // 不同工具需求不同（如 shell_exec 可长，calculator 应短）。
    const toolSchema = toolRegistry.getSchema(tc.function.name)
    const timeoutMs = toolSchema?.timeoutMs ?? TOOL_TIMEOUT_MS
    // 定时器句柄保留：工具先结束时必须 clear，否则 timer 会白挂 N 秒（虽不产生
    // unhandledRejection，但会无谓持有 reject 闭包并推迟进程退出条件）
    let toolTimer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<ToolResult>((_, reject) => {
      toolTimer = setTimeout(
        () => {
          subController.abort() // 超时也主动 abort 底层工具（杀 shell 进程树等）
          reject(new Error(`工具 ${tc.function.name} 执行超时（${timeoutMs / 1000}s）`))
        },
        timeoutMs
      )
    })
    // Agent 中止：主动 abort 底层工具（子控制器负责杀树/取消请求）并让 race 立即出局
    let onAbort: (() => void) | null = null
    const abortPromise = new Promise<ToolResult>((_, reject) => {
      onAbort = () => {
        subController.abort()
        reject(new Error('Agent 运行已中止'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
    })
    try {
      return await Promise.race([toolPromise, timeoutPromise, abortPromise])
    } catch (e) {
      return {
        toolCallId: tc.id,
        name: tc.function.name,
        content: `工具执行失败: ${errMsg(e)}`,
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
