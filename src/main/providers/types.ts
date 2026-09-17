// Provider 适配器抽象接口（L2 模型抽象层）
import type { ToolSchema, ToolCall } from '../../shared/types'

export interface AdapterChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_calls?: ToolCall[] // assistant 消息携带的函数调用
  tool_call_id?: string // role=tool 时关联的调用 ID
  name?: string // role=tool 时的工具名
}

export interface ChatParams {
  model: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  tools?: ToolSchema[] // function calling：传入则模型可决定调用工具
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void
  onToolCallDelta?: (toolCall: ToolCall) => void // 已聚合的工具调用（增量更新，仅用于 UX 预览）
}

/** 流式聊天结果：content 文本 + 可选 tool_calls */
export interface ChatStreamResult {
  content: string
  toolCalls?: ToolCall[]
  finishReason?: string // 'stop' | 'tool_calls' | 'length' | ...
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable: boolean = false
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}

export interface ProviderAdapter {
  /** 拉取模型列表 */
  listModels(): Promise<string[]>
  /** 流式聊天，resolve 时返回完整文本与可选 tool_calls */
  streamChat(
    messages: AdapterChatMessage[],
    params: ChatParams,
    handlers: ChatStreamHandlers
  ): Promise<ChatStreamResult>
  /** 向量化（OpenAI 兼容 /v1/embeddings），返回与输入等长的向量数组 */
  embed(texts: string[], model: string): Promise<number[][]>
}

/** 规范化 base URL：去除末尾斜杠，自动补 /v1 */
export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) {
    url = 'http://' + url
  }
  // 已含版本号前缀则保留，否则补 /v1
  if (/\/v\d+$/.test(url)) return url
  return url + '/v1'
}
