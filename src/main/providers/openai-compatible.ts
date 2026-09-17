// OpenAI 兼容适配器
// 覆盖：OpenAI、Azure(简化)、DeepSeek、Moonshot、Ollama(/v1)、LM Studio、任意 OpenAI-compatible endpoint
// 支持 function calling（tools 参数 + tool_calls 流式聚合）
import {
  ProviderError,
  type AdapterChatMessage,
  type ChatParams,
  type ChatStreamHandlers,
  type ChatStreamResult,
  type ProviderAdapter
} from './types'
import type { ToolCall, ToolSchema } from '../../shared/types'

/** 将统一 ToolSchema 数组转为 OpenAI tools 字段格式 */
function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }))
}

/** 将 AdapterChatMessage 转为 OpenAI messages 格式（带 tool_calls / tool_call_id） */
function toOpenAIMessages(messages: AdapterChatMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.function.name, arguments: tc.function.arguments }
        }))
      }
    }
    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content,
        tool_call_id: m.tool_call_id,
        name: m.name
      }
    }
    return { role: m.role, content: m.content }
  })
}

interface AggregatedToolCall {
  index: number
  id: string
  name: string
  arguments: string
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  private keyIndex = 0

  constructor(
    private readonly baseUrl: string,
    private readonly apiKeys: string[] = []
  ) {}

  private nextKey(): string | null {
    if (this.apiKeys.length === 0) return null
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length]
    this.keyIndex++
    return key
  }

  private authHeaders(key: string | null): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key) headers['Authorization'] = `Bearer ${key}`
    return headers
  }

  async listModels(): Promise<string[]> {
    const errors: string[] = []
    // listModels 最多尝试所有 key 一次
    for (let i = 0; i < Math.max(1, this.apiKeys.length); i++) {
      const key = this.nextKey()
      try {
        const res = await fetch(`${this.baseUrl}/models`, {
          method: 'GET',
          headers: this.authHeaders(key)
        })
        if (!res.ok) {
          errors.push(`HTTP ${res.status}`)
          if (res.status === 401 || res.status === 403) continue
          throw new ProviderError(`获取模型列表失败: HTTP ${res.status}`, res.status)
        }
        const json: any = await res.json()
        const ids: string[] = (json.data ?? [])
          .map((m: any) => m.id as string)
          .filter(Boolean)
        return ids.sort()
      } catch (e) {
        if (e instanceof ProviderError) throw e
        errors.push((e as Error).message)
      }
    }
    throw new ProviderError(`获取模型列表失败: ${errors.join('; ') || '无可用 Key'}`)
  }

  async streamChat(
    messages: AdapterChatMessage[],
    params: ChatParams,
    handlers: ChatStreamHandlers
  ): Promise<ChatStreamResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAIMessages(messages),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
      stream: true
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = toOpenAITools(params.tools)
      body.tool_choice = 'auto'
    }

    const errors: string[] = []
    // 连接建立前的失败可切换 Key 重试；一旦开始读流则不再切换
    for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
      const key = this.nextKey()
      let res: Response
      try {
        res = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: this.authHeaders(key),
          body: JSON.stringify(body),
          signal: params.signal
        })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e
        errors.push((e as Error).message)
        continue
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        // 认证/限流错误尝试下一个 Key
        if ((res.status === 401 || res.status === 403 || res.status === 429) && attempt < this.apiKeys.length - 1) {
          errors.push(`HTTP ${res.status}: ${text.slice(0, 120)}`)
          continue
        }
        throw new ProviderError(
          `请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`,
          res.status,
          res.status === 429 || res.status >= 500
        )
      }

      if (!res.body) throw new ProviderError('响应体为空')

      return await this.readSSE(res, handlers, params.signal)
    }

    throw new ProviderError(`所有 Key 均不可用: ${errors.join('; ')}`)
  }

  private async readSSE(
    res: Response,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal
  ): Promise<ChatStreamResult> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    const toolCallByIndex = new Map<number, AggregatedToolCall>()
    let finishReason: string | undefined

    const onAbort = () => {
      reader.cancel().catch(() => {})
    }
    signal?.addEventListener('abort', onAbort)

    const flushToolCallDeltas = () => {
      if (!handlers.onToolCallDelta) return
      const sorted = Array.from(toolCallByIndex.values()).sort((a, b) => a.index - b.index)
      for (const agg of sorted) {
        handlers.onToolCallDelta({
          id: agg.id,
          type: 'function',
          function: { name: agg.name, arguments: agg.arguments }
        })
      }
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            flushToolCallDeltas()
            return { content: full, toolCalls: finalizeToolCalls(toolCallByIndex), finishReason }
          }
          try {
            const json = JSON.parse(data)
            const choice = json.choices?.[0]
            if (!choice) continue
            if (choice.finish_reason) {
              finishReason = choice.finish_reason
            }
            const delta = choice.delta
            if (!delta) continue

            // 文本增量
            const textDelta = delta.content
            if (typeof textDelta === 'string' && textDelta.length > 0) {
              full += textDelta
              handlers.onDelta(textDelta)
            }

            // tool_calls 增量聚合（OpenAI 把一次调用拆成多段发送）
            const deltaToolCalls: any[] | undefined = delta.tool_calls
            if (Array.isArray(deltaToolCalls)) {
              for (const dtc of deltaToolCalls) {
                const idx: number = typeof dtc.index === 'number' ? dtc.index : 0
                let agg = toolCallByIndex.get(idx)
                if (!agg) {
                  agg = { index: idx, id: '', name: '', arguments: '' }
                  toolCallByIndex.set(idx, agg)
                }
                if (dtc.id) agg.id = dtc.id
                if (dtc.type) {
                  // type 字段，OpenAI 通常为 'function'
                }
                if (dtc.function?.name) agg.name = agg.name + dtc.function.name
                if (dtc.function?.arguments) agg.arguments = agg.arguments + dtc.function.arguments
              }
              flushToolCallDeltas()
            }
          } catch {
            // 忽略不完整 JSON 片段
          }
        }
      }
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }

    flushToolCallDeltas()
    return { content: full, toolCalls: finalizeToolCalls(toolCallByIndex), finishReason }
  }

  /** 批量向量化（OpenAI 兼容 /v1/embeddings） */
  async embed(texts: string[], model: string): Promise<number[][]> {
    const errors: string[] = []
    for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
      const key = this.nextKey()
      try {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: this.authHeaders(key),
          body: JSON.stringify({ model, input: texts })
        })
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if ((res.status === 401 || res.status === 403 || res.status === 429) && attempt < this.apiKeys.length - 1) {
            errors.push(`HTTP ${res.status}`)
            continue
          }
          throw new ProviderError(`向量化失败 HTTP ${res.status}: ${text.slice(0, 200)}`, res.status)
        }
        const json: any = await res.json()
        const data: any[] = json.data ?? []
        // OpenAI 规范保证按 input 顺序返回，但保险起见按 index 排序
        data.sort((a, b) => a.index - b.index)
        return data.map((d) => d.embedding as number[])
      } catch (e) {
        if (e instanceof ProviderError) throw e
        errors.push((e as Error).message)
      }
    }
    throw new ProviderError(`向量化失败: ${errors.join('; ') || '无可用 Key'}`)
  }
}

/** 把聚合的工具调用整理成最终 ToolCall 数组（丢弃空 ID 的） */
function finalizeToolCalls(map: Map<number, AggregatedToolCall>): ToolCall[] | undefined {
  if (map.size === 0) return undefined
  const sorted = Array.from(map.values()).sort((a, b) => a.index - b.index)
  const out: ToolCall[] = []
  for (const agg of sorted) {
    if (!agg.name && !agg.arguments) continue
    out.push({
      id: agg.id || `call_${agg.index}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: agg.name, arguments: agg.arguments || '{}' }
    })
  }
  return out.length > 0 ? out : undefined
}
