// 小模型工具调用文本协议（ReAct 兜底）
//
// 背景：Agent 工具链依赖模型原生 function calling；不支持 tools 的本地小模型
// 会直接报错或忽略工具。本模块提供文本协议兜底：
//  1. isToolsUnsupportedError：识别 provider 的「模型不支持 tools」类报错；
//  2. buildTextProtocolPrompt：把工具清单以文本形式注入 system prompt，
//     约定模型用 ```tool_call 围栏 JSON 声明调用；
//  3. extractTextToolCalls：从模型纯文本回复中抽取工具调用。
// 全部纯函数，引擎侧负责执行与消息回填。
import type { ToolSchema } from './types'

/** 匹配 Ollama / LM Studio / vLLM 等主流端点的「不支持 tools」报错文案 */
export function isToolsUnsupportedError(message: string): boolean {
  return /does not support (?:the )?tools?|tools? (?:are )?not supported|unsupported[^\n]*tools?|not support tool/i.test(
    String(message ?? '')
  )
}

export interface TextToolCall {
  name: string
  arguments: Record<string, unknown>
}

export interface ExtractTextToolCallsResult {
  calls: TextToolCall[]
  /** 出现了 ```tool_call 围栏但内容不是合法 JSON——可提示模型纠正后重试 */
  hasBadBlock: boolean
}

const TOOL_CALL_FENCE_RE = /```tool_call[ \t]*\r?\n?([\s\S]*?)```/g

/** 解析围栏内 JSON → TextToolCall；返回 null 表示该块非法 */
function parseCallBlock(raw: string): TextToolCall | null {
  let obj: unknown
  try {
    obj = JSON.parse(raw.trim())
  } catch {
    return null
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return null
  const rec = obj as Record<string, unknown>
  const name = rec.name
  if (typeof name !== 'string' || !name.trim()) return null
  const args = rec.arguments
  return {
    name: name.trim(),
    arguments:
      typeof args === 'object' && args !== null && !Array.isArray(args)
        ? (args as Record<string, unknown>)
        : {}
  }
}

/**
 * 从模型回复文本中抽取工具调用。
 * - ```tool_call 围栏块（可多个）：JSON 合法且含非空 name 即收录；JSON 非法 → hasBadBlock
 * - 无围栏时宽松兜底：整段恰是一个含 name+arguments 的 JSON 对象，且 name 命中已知
 *   工具清单（传入时）→ 视为单次调用；否则视为纯文本回答
 */
export function extractTextToolCalls(
  text: string,
  knownToolNames?: ReadonlySet<string>
): ExtractTextToolCallsResult {
  const src = String(text ?? '')
  const calls: TextToolCall[] = []
  let hasBadBlock = false

  const fenced = [...src.matchAll(TOOL_CALL_FENCE_RE)]
  for (const m of fenced) {
    const call = parseCallBlock(m[1] ?? '')
    if (call) calls.push(call)
    else hasBadBlock = true
  }
  if (fenced.length > 0) return { calls, hasBadBlock }

  // 无围栏：整段宽松兜底（防小模型忘写围栏）
  const trimmed = src.trim()
  if (!trimmed || !trimmed.startsWith('{')) return { calls, hasBadBlock }
  let obj: unknown
  try {
    obj = JSON.parse(trimmed)
  } catch {
    return { calls, hasBadBlock }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return { calls, hasBadBlock }
  const rec = obj as Record<string, unknown>
  if (typeof rec.name !== 'string' || !('arguments' in rec)) return { calls, hasBadBlock }
  const call = parseCallBlock(trimmed)
  if (!call) return { calls, hasBadBlock }
  // 宽松路径要求 name 命中已知工具，防止把恰好含 name/arguments 字段的普通 JSON 回答误判为调用
  if (knownToolNames && !knownToolNames.has(call.name)) return { calls, hasBadBlock }
  return { calls: [call], hasBadBlock }
}

/**
 * 生成注入 system prompt 的文本协议说明（含工具清单）。
 * 与 extractTextToolCalls 的解析规则严格对应。
 */
export function buildTextProtocolPrompt(tools: ToolSchema[]): string {
  const lines: string[] = [
    '',
    '## 工具调用协议（重要）',
    '',
    '你可以调用工具。调用方法是：在回复中输出 ```tool_call 代码围栏，围栏内为 JSON 对象，',
    '格式：{"name": "工具名", "arguments": { 参数对象 }}。一次可输出多个围栏块调用多个工具。',
    '不要在 JSON 外的围栏内写注释。不需要工具时直接用自然语言回答，不要输出 tool_call 围栏。',
    '输出围栏后请立即结束本轮回复，等待系统提供工具结果。',
    '',
    '可用工具清单：'
  ]
  for (const tool of tools) {
    lines.push(`### ${tool.name}`)
    if (tool.description) lines.push(tool.description)
    lines.push(`参数(JSON Schema): ${JSON.stringify(tool.parameters ?? {})}`)
  }
  lines.push('')
  return lines.join('\n')
}
