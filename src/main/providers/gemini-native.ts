// Google Gemini generateContent API 原生适配器（/v1beta 或 /v1 均可，随 baseUrl 而定）。
// 用 x-goog-api-key 头传 Key，不写进 URL，避免日志/历史记录泄漏。
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

interface ModelsResponse {
  models?: Array<{ name?: unknown }>
}

interface EmbedResponse {
  embedding?: { values?: unknown }
}

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: unknown[] }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    cachedContentTokenCount?: number
  }
}

interface GeminiPart {
  text?: string
  functionCall?: { name?: string; args?: unknown }
  [key: string]: unknown
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

function argumentsOf(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return { _raw: raw }
  }
}

function toGeminiContents(messages: AdapterChatMessage[]): { systemInstruction?: { parts: GeminiPart[] }; contents: GeminiContent[] } {
  const systemTexts = messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string' && m.content.trim())
    .map((m) => String(m.content).trim())
  const contents: GeminiContent[] = []
  const push = (role: 'user' | 'model', parts: GeminiPart[]): void => {
    const last = contents[contents.length - 1]
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      push('user', [{
        functionResponse: {
          name: m.name ?? '',
          response: { result: typeof m.content === 'string' ? m.content : '' }
        }
      }])
      continue
    }
    if (m.role === 'assistant') {
      const parts: GeminiPart[] = []
      if (typeof m.content === 'string' && m.content) parts.push({ text: m.content })
      for (const call of m.tool_calls ?? []) {
        parts.push({ functionCall: { name: call.function.name, args: argumentsOf(call.function.arguments) } })
      }
      push('model', parts.length > 0 ? parts : [{ text: '' }])
      continue
    }
    const parts: GeminiPart[] = []
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content })
    } else {
      for (const part of m.content) {
        if (part.type === 'text' && part.text) parts.push({ text: part.text })
        if (part.type === 'image_url' && part.image_url?.url) {
          parts.push({ fileData: { fileUri: part.image_url.url, mimeType: 'image/*' } })
        }
      }
    }
    push('user', parts.length > 0 ? parts : [{ text: '' }])
  }

  return {
    ...(systemTexts.length > 0
      ? { systemInstruction: { parts: [{ text: systemTexts.join('\n\n') }] } }
      : {}),
    contents
  }
}

function toGeminiTools(tools: NonNullable<ChatParams['tools']>): unknown[] {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }]
}

function mapFinishReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined
  if (reason === 'STOP') return 'stop'
  if (reason === 'MAX_TOKENS') return 'length'
  if (reason === 'RECITATION' || reason === 'SAFETY') return 'content_filter'
  if (reason === 'FUNCTION_CALL') return 'tool_calls'
  return reason.toLowerCase()
}

function modelName(model: string): string {
  return model.startsWith('models/') ? model.slice('models/'.length) : model
}

export class GeminiNativeAdapter {
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
    return { 'Content-Type': 'application/json', 'x-goog-api-key': key }
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
        const json = (await res.json()) as ModelsResponse
        return (json.models ?? [])
          .map((m) => (typeof m.name === 'string' ? modelName(m.name) : ''))
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
    const converted = toGeminiContents(messages)
    const generationConfig: Record<string, unknown> = {
      temperature: params.temperature ?? 0.7,
      maxOutputTokens: params.maxTokens
    }
    if (typeof params.topP === 'number') generationConfig.topP = params.topP

    const body: Record<string, unknown> = {
      contents: converted.contents,
      ...(converted.systemInstruction ? { systemInstruction: converted.systemInstruction } : {}),
      generationConfig
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = toGeminiTools(params.tools)
      const mode = params.toolChoice === 'none' ? 'NONE' : params.toolChoice === 'required' ? 'ANY' : 'AUTO'
      body.toolConfig = { functionCallingConfig: { mode } }
    }

    const timers = createStreamTimers(params)
    const errors: string[] = []
    try {
      for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
        const key = this.nextKey()
        if (!key) break
        const url = `${this.baseUrl}/models/${encodeURIComponent(modelName(params.model))}:streamGenerateContent?alt=sse`
        let res: Response
        try {
          res = await fetch(url, {
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
        let finishReason: string | undefined
        let promptTokens = 0
        let completionTokens = 0
        let cachedTokens = 0
        const toolCalls: ToolCall[] = []

        const onEvent = (data: string): void => {
          let json: GeminiResponse
          try {
            json = JSON.parse(data) as GeminiResponse
          } catch {
            return
          }
          const usage = json.usageMetadata
          if (usage) {
            promptTokens = usage.promptTokenCount ?? promptTokens
            completionTokens = usage.candidatesTokenCount ?? completionTokens
            cachedTokens = usage.cachedContentTokenCount ?? cachedTokens
          }
          const candidate = json.candidates?.[0]
          if (!candidate) return
          if (candidate.finishReason) finishReason = candidate.finishReason
          for (const part of (candidate.content?.parts ?? []) as GeminiPart[]) {
            if (typeof part.text === 'string' && part.text) {
              content += part.text
              handlers.onDelta(part.text)
            }
            if (part.functionCall?.name) {
              const call: ToolCall = {
                id: `gemini_${toolCalls.length}_${part.functionCall.name}`,
                type: 'function',
                function: {
                  name: part.functionCall.name,
                  arguments: JSON.stringify(part.functionCall.args ?? {})
                }
              }
              toolCalls.push(call)
              handlers.onToolCallDelta?.(call)
            }
          }
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
        if (toolCalls.length > 0 && !finishReason) finishReason = 'FUNCTION_CALL'
        return {
          content,
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

  /** Gemini embedContent 一次只收一段文本，这里按顺序逐条请求 */
  async embed(texts: string[], model: string): Promise<number[][]> {
    const name = modelName(model)
    const vectors: number[][] = []
    for (const text of texts) {
      let lastError: ProviderError | undefined
      let succeeded = false
      for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
        const key = this.nextKey()
        if (!key) break
        try {
          const res = await fetch(`${this.baseUrl}/models/${encodeURIComponent(name)}:embedContent`, {
            method: 'POST',
            headers: this.headers(key),
            body: JSON.stringify({
              model: `models/${name}`,
              content: { parts: [{ text }] }
            }),
            signal: AbortSignal.timeout(180_000),
            ...NO_REDIRECT
          })
          assertNoRedirect(res)
          if (!res.ok) {
            const errText = await res.text().catch(() => '')
            lastError = new ProviderError(
              `向量化失败 HTTP ${res.status}: ${redactSecretsInText(errText).slice(0, 200)}`,
              res.status,
              res.status === 429 || res.status >= 500
            )
            if (res.status === 401 || res.status === 403 || res.status === 429) continue
            throw lastError
          }
          const json = (await res.json()) as EmbedResponse
          const values = json.embedding?.values
          vectors.push(Array.isArray(values) ? values.filter((v): v is number => typeof v === 'number') : [])
          succeeded = true
          lastError = undefined
          break
        } catch (e) {
          if (e instanceof ProviderError) throw e
          lastError = new ProviderError(`向量化失败: ${errMsg(e)}`)
        }
      }
      if (lastError) throw lastError
      if (!succeeded) throw new ProviderError('向量化失败: 未配置 API Key')
    }
    return vectors
  }
}
