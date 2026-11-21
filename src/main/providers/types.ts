// Provider 适配器抽象接口（L2 模型抽象层）
import type { ToolSchema, ToolCall } from '../../shared/types'
import { ensureScheme, isLoopbackHost } from '../../shared/url-policy'
import { isPrivateHostname } from '../net/safe-fetch'

export interface MessageContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string; detail?: 'auto' | 'low' | 'high' }
}

export interface AdapterChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | MessageContentPart[]
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
  toolChoice?: 'auto' | 'none' | 'required' // 工具调用策略，默认 'auto'
  // ── v78：生成参数补齐（此前只有 temperature/maxTokens 真正发出去，其余在助手 defaultParams 里配了也无效）
  topP?: number
  frequencyPenalty?: number
  presencePenalty?: number
  /** OpenAI `parallel_tool_calls`：只在本次请求带 tools 时下发 */
  parallelToolCalls?: boolean
  /** Qwen/DashScope `enable_thinking`：仅显式配置时下发（不认识的端点会 400） */
  enableThinking?: boolean
  /** §246 本地槽位排到了、请求开始往外发的那一刻回调一次（探针用它起超时，见 local-slot 的注释） */
  onSlotStart?: () => void
}

export interface ChatStreamHandlers {
  onDelta: (text: string) => void
  onToolCallDelta?: (toolCall: ToolCall) => void // 已聚合的工具调用（增量更新，仅用于 UX 预览）
  onReasoningDelta?: (text: string) => void // 推理/思考过程增量（qwen 等模型返回 reasoning_content）
}

/** 流式聊天结果：content 文本 + 可选 tool_calls */
export interface ChatStreamResult {
  content: string
  reasoning?: string // 推理/思考过程（部分模型返回）
  toolCalls?: ToolCall[]
  finishReason?: string // 'stop' | 'tool_calls' | 'length' | ...
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
    cachedTokens?: number // 命中缓存的输入 token 数（Anthropic cache_read / OpenAI cached_tokens）
  }
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly retryable: boolean = false,
    /** 服务端 `Retry-After` 解析出的等待毫秒数（429 常见）；缺省表示服务端没给 */
    public readonly retryAfterMs?: number
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

/**
 * Provider baseUrl 的 SSRF 边界（M9）：字面内网/保留地址与非回环明文 http 一律拒绝。
 * 域名解析到私网由 safeFetch 在建连时拦截（ providerFetchJson 已收敛）；这里先挡字面量。
 */
export function assertProviderBaseUrlSafe(raw: string): void {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error(`Provider Base URL 无效: ${raw}`)
  }
  const loopback = isLoopbackHost(u.hostname.toLowerCase())
  if (u.protocol === 'http:' && !loopback) {
    throw new Error('Provider Base URL 非本机地址必须使用 https（明文会泄露 API Key）')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`Provider Base URL 仅支持 http(s): ${u.protocol}`)
  }
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!loopback && isPrivateHostname(host)) {
    throw new Error(`Provider Base URL 不能指向内网/保留地址: ${host}`)
  }
}

/** 规范化 base URL：去除末尾斜杠，缺协议按 https 优先补全，自动补 /v1 */
export function normalizeBaseUrl(input: string): string {
  let url = ensureScheme(input.trim().replace(/\/+$/, ''))
  assertProviderBaseUrlSafe(url)
  // 已含版本号前缀则保留，否则补 /v1
  if (/\/v\d+$/.test(url)) return url
  return url + '/v1'
}
