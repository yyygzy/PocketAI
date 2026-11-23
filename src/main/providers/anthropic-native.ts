// Anthropic Messages API 原生适配器（/v1/messages + SSE）。
// 与旧的 OpenAI 兼容路径相比，原生 path 能拿到真实的 stop_reason、tool_use 块、
// cache_read_input_tokens 用量，也不用依赖第三方兼容层的字段映射。
import {
  ProviderError,
  type AdapterChatMessage,
  type ChatParams,
  type ChatStreamHandlers,
  type ChatStreamResult
} from './types'
import type { ToolCall } from '../../shared/types'
import { withLocalSlot } from './local-slot'
import { errMsg, isAbortError } from '../error'
import { redactSecretsInText } from '../security/audit-redact'
import {
  NO_REDIRECT,
  assertNoRedirect,
  createStreamTimers,
  parseRetryAfterMs,
  readSSE
} from './native-stream'

const ANTHROPIC_VERSION = '2023-06-01'

interface ModelListResponse {
  data?: Array<{ id?: unknown }>
}

interface ToolUseAggregate {
  index: number
  id: string
  name: string
  input: string
}

interface AnthropicEvent {
  type?: string
  index?: number
  content_block?: { type?: string; id?: string; name?: string; input?: unknown }
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
  message?: { usage?: { input_tokens?: number; cache_read_input_tokens?: number } }
  usage?: { output_tokens?: number; input_tokens?: number; cache_read_input_tokens?: number }
}

function parseToolArguments(raw: string, name: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    // 参数片段不完整时保留原文，让引擎侧的参数校验给出可诊断错误
    return { _raw: raw, _name: name }
  }
}

function toAnthropicTools(tools: NonNullable<ChatParams['tools']>): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters
  }))
}

function toAnthropicMessages(messages: AdapterChatMessage[]): { system?: unknown; messages: unknown[] } {
  const systemTexts = messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.trim())
    .map((m) => String(m.content).trim())
  const out: Array<{ role: 'user' | 'assistant'; content: unknown[] }> = []

  const pushUser = (blocks: unknown[]): void => {
    const last = out[out.length - 1]
    if (last?.role === 'user' && blocks.every((b) => (b as { type?: string }).type === 'tool_result')) {
      last.content = [...last.content, ...blocks]
      return
    }
    out.push({ role: 'user', content: blocks })
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      pushUser([{
        type: 'tool_result',
        tool_use_id: m.tool_call_id,
        content: typeof m.content === 'string' ? m.content : ''
      }])
      continue
    }
    if (m.role === 'assistant') {
      const blocks: unknown[] = []
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content })
      for (const call of m.tool_calls ?? []) {
        blocks.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: parseToolArguments(call.function.arguments, call.function.name)
        })
      }
      out.push({ role: 'assistant', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] })
      continue
    }
    const blocks: unknown[] = []
    if (typeof m.content === 'string') {
      if (m.content) blocks.push({ type: 'text', text: m.content })
    } else {
      for (const part of m.content) {
        if (part.type === 'text' && part.text) blocks.push({ type: 'text', text: part.text })
        if (part.type === 'image_url' && part.image_url?.url) {
          blocks.push({ type: 'image', source: { type: 'url', url: part.image_url.url } })
        }
      }
    }
    out.push({ role: 'user', content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] })
  }

  return {
    ...(systemTexts.length > 0
      ? { system: [{ type: 'text', text: systemTexts.join('\n\n'), cache_control: { type: 'ephemeral' } }] }
      : {}),
    messages: out
  }
}

export class AnthropicNativeAdapter {
  private keyIndex = 0

  constructor(
    private readonly baseUrl: string,
    private readonly apiKeys: string[] = []
  ) {}

  private nextKey(): string | null {
    if (this.apiKeys.length === 0) return null
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length]
    this.keyIndex++
    return key ?? null
  }

  private headers(key: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': ANTHROPIC_VERSION
    }
  }

  async listModels(): Promise<string[]> {
    const errors: string[] = []
    for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
      const key = this.nextKey()
      if (!key) break
      try {
        const res = await fetch(`${this.baseUrl}/models`, {
          method: 'GET',
          headers: this.headers(key),
          signal: AbortSignal.timeout(180_000),
          ...NO_REDIRECT
        })
        assertNoRedirect(res)
        if (!res.ok) {
          errors.push(`HTTP ${res.status}`)
          if (res.status === 401 || res.status === 403) continue
          throw new ProviderError(`获取模型列表失败: HTTP ${res.status}`, res.status)
        }
        const json = (await res.json()) as ModelListResponse
        return (json.data ?? [])
          .map((m) => (typeof m.id === 'string' ? m.id : ''))
          .filter(Boolean)
          .sort()
      } catch (e) {
        if (e instanceof ProviderError) throw e
        errors.push(errMsg(e))
      }
    }
    throw new ProviderError(`获取模型列表失败: ${errors.join('; ') || '未配置 API Key'}`)
  }

  async streamChat(
    messages: AdapterChatMessage[],
    params: ChatParams,
    handlers: ChatStreamHandlers
  ): Promise<ChatStreamResult> {
    return withLocalSlot(
      { baseUrl: this.baseUrl, lane: 'chat', label: params.model, signal: params.signal, onStart: params.onSlotStart },
      () => this.streamChatInner(messages, params, handlers)
    )
  }

  private async streamChatInner(
    messages: AdapterChatMessage[],
    params: ChatParams,
    handlers: ChatStreamHandlers
  ): Promise<ChatStreamResult> {
    const maxTokens = params.maxTokens ?? 4096
    const converted = toAnthropicMessages(messages)
    const body: Record<string, unknown> = {
      model: params.model,
      max_tokens: maxTokens,
      temperature: params.temperature ?? 0.7,
      stream: true,
      ...(converted.system ? { system: converted.system } : {}),
      messages: converted.messages
    }
    if (typeof params.topP === 'number') body.top_p = params.topP
    if (params.tools && params.tools.length > 0) {
      body.tools = toAnthropicTools(params.tools)
      const choice = params.toolChoice ?? 'auto'
      body.tool_choice = { type: choice === 'none' ? 'none' : choice === 'required' ? 'any' : 'auto' }
    }

    const timers = createStreamTimers(params)
    const errors: string[] = []
    try {
      for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
        const key = this.nextKey()
        if (!key) break
        let res: Response
        try {
          res = await fetch(`${this.baseUrl}/messages`, {
            method: 'POST',
            headers: this.headers(key),
            body: JSON.stringify(body),
            signal: timers.signal,
            ...NO_REDIRECT
          })
        } catch (e) {
          const te = timers.timeoutError()
          if (te) throw te
          if (isAbortError(e) || e instanceof ProviderError) throw e
          errors.push(errMsg(e))
          continue
        }
        timers.armActivity()
        assertNoRedirect(res)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if ((res.status === 401 || res.status === 403 || res.status === 429) && attempt < this.apiKeys.length - 1) {
            errors.push(`HTTP ${res.status}`)
            continue
          }
          throw new ProviderError(
            `请求失败 HTTP ${res.status}: ${redactSecretsInText(text).slice(0, 200)}`,
            res.status,
            res.status === 429 || res.status >= 500,
            parseRetryAfterMs(res.headers.get('retry-after'))
          )
        }

        let content = ''
        let reasoning = ''
        let finishReason: string | undefined
        let promptTokens = 0
        let cachedTokens = 0
        let completionTokens = 0
        const toolAggregates = new Map<number, ToolUseAggregate>()

        const finalizeToolCalls = (): ToolCall[] => Array.from(toolAggregates.values())
          .sort((a, b) => a.index - b.index)
          .map((agg) => ({
            id: agg.id,
            type: 'function' as const,
            function: { name: agg.name, arguments: agg.input }
          }))

        const onEvent = (data: string): boolean => {
          let event: AnthropicEvent
          try {
            event = JSON.parse(data) as AnthropicEvent
          } catch {
            return false
          }
          if (event.type === 'message_start') {
            const usage = event.message?.usage
            promptTokens = usage?.input_tokens ?? 0
            cachedTokens = usage?.cache_read_input_tokens ?? 0
            return false
          }
          if (event.type === 'content_block_start') {
            const block = event.content_block
            if (block?.type === 'tool_use') {
              toolAggregates.set(event.index ?? 0, {
                index: event.index ?? 0,
                id: block.id ?? '',
                name: block.name ?? '',
                input: ''
              })
            }
            return false
          }
          if (event.type === 'content_block_delta') {
            const delta = event.delta
            if (delta?.type === 'text_delta' && delta.text) {
              content += delta.text
              handlers.onDelta(delta.text)
            } else if (delta?.type === 'thinking_delta' && delta.text) {
              reasoning += delta.text
              handlers.onReasoningDelta?.(delta.text)
            } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
              const agg = toolAggregates.get(event.index ?? 0)
              if (agg) {
                agg.input += delta.partial_json
                handlers.onToolCallDelta?.({
                  id: agg.id,
                  type: 'function',
                  function: { name: agg.name, arguments: agg.input }
                })
              }
            }
            return false
          }
          if (event.type === 'message_delta') {
            finishReason = event.delta?.stop_reason
            const out = event.usage?.output_tokens
            if (typeof out === 'number') completionTokens = out
            return false
          }
          if (event.type === 'message_stop') return true
          return false
        }

        try {
          await readSSE(res, onEvent, timers.signal, timers.armActivity)
        } catch (e) {
          const te = timers.timeoutError()
          if (te) throw te
          if (isAbortError(e) || e instanceof ProviderError) throw e
          errors.push(errMsg(e))
          continue
        }
        const toolCalls = finalizeToolCalls()
        if (toolCalls.length > 0) finishReason ??= 'tool_calls'
        return {
          content,
          ...(reasoning ? { reasoning } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          finishReason: mapFinishReason(finishReason),
          usage: {
            promptTokens,
            completionTokens,
            totalTokens: promptTokens + completionTokens,
            ...(cachedTokens > 0 ? { cachedTokens } : {})
          }
        }
      }
      throw new ProviderError(`所有 Key 均不可用: ${errors.join('; ') || '未配置 API Key'}`)
    } finally {
      timers.cleanup()
    }
  }

  /** Anthropic 没有 embedding 端点；明确报错，避免误打 /v1/messages 得到垃圾向量 */
  async embed(_texts: string[], _model: string): Promise<number[][]> {
    throw new ProviderError('Anthropic 原生适配器不支持向量化，请改用支持 embeddings 的 Provider')
  }
}

function mapFinishReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  if (reason === 'end_turn') return 'stop'
  if (reason === 'tool_use') return 'tool_calls'
  if (reason === 'max_tokens') return 'length'
  return reason
}
