// OpenAI 兼容适配器
// 覆盖：OpenAI、Azure(简化)、DeepSeek、Moonshot、Ollama(/v1)、LM Studio、任意 OpenAI-compatible endpoint
// 支持 function calling（tools 参数 + tool_calls 流式聚合）
import {
  ProviderError,
  type AdapterChatMessage,
  type MessageContentPart,
  type ChatParams,
  type ChatStreamHandlers,
  type ChatStreamResult,
  type ProviderAdapter
} from './types'
import type { ToolCall, ToolSchema } from '../../shared/types'
import { withLocalSlot } from './local-slot'
import { errMsg, isAbortError } from '../error'
import { redactSecretsInText } from '../security/audit-redact'

/** 所有携带 Bearer API Key 的请求统一使用的 fetch 选项片段。
 *  redirect:'manual'：fetch 默认 follow 会把 Authorization 头原样带给 Location
 *  指向的任意主机（含 http 降级目标），等于泄漏 API Key。provider 正规部署
 *  不会对 API 端点发 3xx，因此直接拒绝重定向最安全。 */
const NO_REDIRECT: RequestInit = { redirect: 'manual' }

/**
 * 云 API 的三种"时间"必须分开看（v78 网络层加固）：
 *  · 首字节超时：请求已发出但服务端迟迟不回响应头（排队/网关卡住）；
 *  · 流空闲超时：已经开始吐字，但长时间没有新 chunk（代理断流）；
 *  · 总时长：兜住"慢慢吐、永远吐不完"。
 * 为什么不能只靠引擎那 5 分钟整轮预算：它兜住的是整轮 Agent，一次调用卡死会把后面
 * 所有步骤的预算一起烧掉，错误也只剩"运行已中止"，分不清网络还是服务问题。
 */
const FIRST_BYTE_TIMEOUT_MS = 90_000
const STREAM_IDLE_TIMEOUT_MS = 60_000
const REQUEST_TOTAL_TIMEOUT_MS = 180_000

/** `Retry-After` 只接受官方两种形态：秒数、HTTP 日期；解析不出返回 undefined */
export function parseRetryAfterMs(header: string | null | undefined, now = Date.now()): number | undefined {
  const raw = String(header ?? '').trim()
  if (!raw) return undefined
  const asNumber = Number(raw)
  if (Number.isFinite(asNumber) && asNumber >= 0) return Math.floor(asNumber * 1000)
  const at = Date.parse(raw)
  if (!Number.isFinite(at)) return undefined
  return Math.max(0, at - now)
}

/**
 * 400/422 且报文指向 `stream_options`/`include_usage`/未知参数时，判定为"该端点不认这个字段"。
 * 为什么不看所有 400：`tools` 类 400 要留给文本协议降级路径，吞掉会把真正的原因藏起来。
 */
export function isStreamOptionsUnsupported(status: number, text: string): boolean {
  if (status !== 400 && status !== 422) return false
  const t = String(text ?? '')
  if (/tools?/i.test(t) && !/stream_options|include_usage/i.test(t)) return false
  return /stream_options|include_usage|unknown (?:field|parameter|argument)|unrecognized (?:field|parameter|argument)|extra fields (?:are )?not permitted/i.test(
    t
  )
}

// ─── OpenAI 兼容响应形状（外部 API 边界，按用到字段最小声明）──────
interface ModelsListResponse {
  data?: Array<{ id?: unknown }>
}

interface StreamToolCallDelta {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

interface StreamChunk {
  choices?: Array<{
    finish_reason?: string
    delta?: {
      content?: unknown
      reasoning_content?: unknown
      tool_calls?: StreamToolCallDelta[]
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    // Anthropic（OpenAI 兼容端点透传）：命中缓存的输入 token 数
    cache_read_input_tokens?: number
    // OpenAI 官方：缓存命中详情
    prompt_tokens_details?: { cached_tokens?: number } | null
  }
}

interface EmbeddingsResponse {
  data?: Array<{ index: number; embedding: number[] }>
}

interface ImagesGenerationResponse {
  data?: Array<{ b64_json?: unknown; url?: unknown }>
}

/** 拒绝 3xx（配合 redirect:'manual'），给出可诊断的错误而非把 Key 发去第三方 */
function assertNoRedirect(res: Response): void {
  if (res.status >= 300 && res.status < 400) {
    throw new ProviderError(
      '服务端返回了重定向，已拒绝跟随（防止 API Key 被发送到重定向目标主机）；请检查 Base URL 是否正确',
      res.status
    )
  }
}

/** 将统一 ToolSchema 数组转为 OpenAI tools 字段格式 */
export function toOpenAITools(tools: ToolSchema[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }
  }))
}

/** Anthropic prompt caching：cache_control 断点标记（OpenAI 兼容端点透传） */
const CACHE_CONTROL = { type: 'ephemeral' } as const

/**
 * 把文本内容包成 content blocks 并在最后一个块上打 cache_control 断点。
 * Anthropic 缓存以断点前缀为单位：system + 最新用户轮之前的全部历史可被缓存复用，
 * 多轮对话下每轮新请求命中上一轮写入的缓存前缀，输入 token 按约 1/10 计价。
 */
function markCacheBreakpoint(content: string | MessageContentPart[]): unknown {
  if (typeof content === 'string') {
    if (!content) return content // 空文本不打标记（无效块会被 Anthropic 拒绝）
    return [{ type: 'text', text: content, cache_control: CACHE_CONTROL }]
  }
  if (content.length === 0) return content
  // 多模态：最后一个 part 打标记（不修改原对象，避免副作用）
  return content.map((p, i) => (i === content.length - 1 ? { ...p, cache_control: CACHE_CONTROL } : p))
}

/** 将 AdapterChatMessage 转为 OpenAI messages 格式（带 tool_calls / tool_call_id）。
 *  promptCache=true（Anthropic 型 provider）时对 system 与最后一条 user 消息打
 *  cache_control 断点；其余消息保持原样，false 时输出与原实现完全一致。 */
export function toOpenAIMessages(messages: AdapterChatMessage[], promptCache = false): unknown[] {
  let lastUserIdx = -1
  if (promptCache) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]!.role === 'user') {
        lastUserIdx = i
        break
      }
    }
  }
  return messages.map((m, idx) => {
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
    if (promptCache && (m.role === 'system' || idx === lastUserIdx)) {
      return { role: m.role, content: markCacheBreakpoint(m.content) }
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
    private readonly apiKeys: string[] = [],
    /** Anthropic prompt caching：对 system 与最后一条 user 消息打 cache_control 断点 */
    private readonly promptCache = false
  ) {}

  private nextKey(): string | null {
    if (this.apiKeys.length === 0) return null
    const key = this.apiKeys[this.keyIndex % this.apiKeys.length]
    this.keyIndex++
    return key ?? null
  }

  private authHeaders(key: string | null): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (key) headers['Authorization'] = `Bearer ${key}`
    return headers
  }

  /** 拉取模型列表：**故意不过槽**——它是设置页的元数据请求，
   *  让"列表刷新"排在一次正在进行的生成为后面，只会把界面冻住，换不到任何显存收益。 */
  async listModels(): Promise<string[]> {
    const errors: string[] = []
    // listModels 最多尝试所有 key 一次
    for (let i = 0; i < Math.max(1, this.apiKeys.length); i++) {
      const key = this.nextKey()
      try {
        const res = await fetch(`${this.baseUrl}/models`, {
          method: 'GET',
          headers: this.authHeaders(key),
          // 元数据请求没有引擎整轮预算兜底：服务端能建连却不回响应时 fetch 永不超时，
          // 设置页会永久转圈、无法取消；这里用总时长硬超时，超时转成下面的 ProviderError。
          signal: AbortSignal.timeout(REQUEST_TOTAL_TIMEOUT_MS),
          ...NO_REDIRECT
        })
        assertNoRedirect(res)
        if (!res.ok) {
          errors.push(`HTTP ${res.status}`)
          if (res.status === 401 || res.status === 403) continue
          throw new ProviderError(`获取模型列表失败: HTTP ${res.status}`, res.status)
        }
        const json = (await res.json()) as ModelsListResponse
        const ids: string[] = (json.data ?? [])
          .map((m) => (typeof m.id === 'string' ? m.id : ''))
          .filter(Boolean)
        return ids.sort()
      } catch (e) {
        if (e instanceof ProviderError) throw e
        errors.push(errMsg(e))
      }
    }
    throw new ProviderError(`获取模型列表失败: ${errors.join('; ') || '无可用 Key'}`)
  }

  /**
   * 闸门放在出口而不是那 12 个调用点（V4-Iter-141）：本地回环请求按容量判据排队，
   * 云地址与"未实测档"原样放行——一行时序都不改。
   * signal 一并交给闸门：等待期间取消也要能退出，否则取消掉的调用会把槽一直占着。
   */
  async streamChat(
    messages: AdapterChatMessage[],
    params: ChatParams,
    handlers: ChatStreamHandlers
  ): Promise<ChatStreamResult> {
    return withLocalSlot(
      {
        baseUrl: this.baseUrl,
        lane: 'chat',
        label: params.model,
        signal: params.signal,
        onStart: params.onSlotStart
      },
      () => this.streamChatInner(messages, params, handlers)
    )
  }

  private async streamChatInner(
    messages: AdapterChatMessage[],
    params: ChatParams,
    handlers: ChatStreamHandlers
  ): Promise<ChatStreamResult> {
    const body: Record<string, unknown> = {
      model: params.model,
      messages: toOpenAIMessages(messages, this.promptCache),
      temperature: params.temperature ?? 0.7,
      max_tokens: params.maxTokens,
      stream: true,
      // 请求服务端在流末尾返回 usage（token 用量），部分兼容服务忽略此字段
      stream_options: { include_usage: true }
    }
    if (params.tools && params.tools.length > 0) {
      body.tools = toOpenAITools(params.tools)
      body.tool_choice = params.toolChoice ?? 'auto'
      if (typeof params.parallelToolCalls === 'boolean') {
        body.parallel_tool_calls = params.parallelToolCalls
      }
    }
    // 生成参数：只下发调用方明确给出的值（不发 undefined，避免"字段存在但值为空"被端点拒绝）
    if (typeof params.topP === 'number') body.top_p = params.topP
    if (typeof params.frequencyPenalty === 'number') body.frequency_penalty = params.frequencyPenalty
    if (typeof params.presencePenalty === 'number') body.presence_penalty = params.presencePenalty
    // Qwen/DashScope 专用：只在用户显式配置时下发（多数 OpenAI 兼容端点不认这个字段）
    if (typeof params.enableThinking === 'boolean') body.enable_thinking = params.enableThinking

    // ── 超时与取消：外部取消 + 内部三档超时合并到同一个 controller ──
    const ac = new AbortController()
    let timedOutPhase: 'first-byte' | 'idle' | 'total' | null = null
    const external = params.signal
    const onExternalAbort = (): void => ac.abort()
    if (external) {
      if (external.aborted) ac.abort()
      else external.addEventListener('abort', onExternalAbort)
    }
    let firstByteTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const totalTimer = setTimeout(() => {
      timedOutPhase ??= 'total'
      ac.abort()
    }, REQUEST_TOTAL_TIMEOUT_MS)
    const armFirstByte = (): void => {
      clearTimeout(firstByteTimer)
      firstByteTimer = setTimeout(() => {
        timedOutPhase ??= 'first-byte'
        ac.abort()
      }, FIRST_BYTE_TIMEOUT_MS)
    }
    /** 收到任一 chunk 就重臂空闲计时；首字节到货前由首字节计时兜住 */
    const armIdle = (): void => {
      clearTimeout(firstByteTimer)
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        timedOutPhase ??= 'idle'
        ac.abort()
      }, STREAM_IDLE_TIMEOUT_MS)
    }
    /** 超时被包装成可重试的 ProviderError；用户主动取消（timedOutPhase 为空）原样抛 */
    const timeoutError = (): ProviderError | null => {
      if (timedOutPhase === 'first-byte') {
        return new ProviderError(
          `请求超时：${FIRST_BYTE_TIMEOUT_MS / 1000}s 内未收到响应（${params.model}）`,
          undefined,
          true
        )
      }
      if (timedOutPhase === 'idle') {
        return new ProviderError(
          `流式响应空闲超时：${STREAM_IDLE_TIMEOUT_MS / 1000}s 无新数据（${params.model}）`,
          undefined,
          true
        )
      }
      if (timedOutPhase === 'total') {
        return new ProviderError(
          `请求总时长超过 ${REQUEST_TOTAL_TIMEOUT_MS / 1000}s（${params.model}）`,
          undefined,
          true
        )
      }
      return null
    }
    const clearTimers = (): void => {
      clearTimeout(firstByteTimer)
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
    }
    armFirstByte()

    try {
      const errors: string[] = []
      /** 连接建立前的失败可切换 Key 重试；一旦开始读流则不再切换 */
      const maxKeyAttempts = Math.max(1, this.apiKeys.length)
      let keyAttempt = 0
      /** stream_options 兼容降级只做一次（同一 Key 重发，不消耗 Key 尝试次数） */
      let optionFallbackUsed = false

      while (keyAttempt < maxKeyAttempts) {
        const key = this.nextKey()
        let res: Response
        try {
          res = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: this.authHeaders(key),
            body: JSON.stringify(body),
            signal: ac.signal,
            ...NO_REDIRECT
          })
        } catch (e) {
          const te = timeoutError()
          if (te) throw te
          if (isAbortError(e) || e instanceof ProviderError) throw e
          errors.push(errMsg(e))
          keyAttempt++
          continue
        }
        // 响应头已到：首字节计时结束，转入流空闲计时
        clearTimeout(firstByteTimer)
        assertNoRedirect(res)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if (!optionFallbackUsed && isStreamOptionsUnsupported(res.status, text)) {
            optionFallbackUsed = true
            delete body.stream_options
            continue
          }
          const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
          // 认证/限流错误尝试下一个 Key
          if (
            (res.status === 401 || res.status === 403 || res.status === 429) &&
            keyAttempt < maxKeyAttempts - 1
          ) {
            errors.push(`HTTP ${res.status}: ${redactSecretsInText(text).slice(0, 120)}`)
            keyAttempt++
            continue
          }
          throw new ProviderError(
            `请求失败 HTTP ${res.status}: ${redactSecretsInText(text).slice(0, 200)}`,
            res.status,
            res.status === 429 || res.status >= 500,
            retryAfterMs
          )
        }

        if (!res.body) throw new ProviderError('响应体为空')
        armIdle()
        try {
          return await this.readSSE(res, handlers, ac.signal, armIdle)
        } catch (e) {
          const te = timeoutError()
          if (te) throw te
          throw e
        }
      }

      throw new ProviderError(`所有 Key 均不可用: ${errors.join('; ')}`)
    } finally {
      clearTimers()
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  private async readSSE(
    res: Response,
    handlers: ChatStreamHandlers,
    signal?: AbortSignal,
    /** 每收到一个 chunk 回调一次：调用方用它重臂「流空闲」计时 */
    onActivity?: () => void
  ): Promise<ChatStreamResult> {
    // 防御性二次守卫：调用方已 throw 但 TS 不能跨方法保持收窄，readSSE 自包含
    if (!res.body) throw new ProviderError('响应体为空')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let reasoning = ''
    const toolCallByIndex = new Map<number, AggregatedToolCall>()
    let finishReason: string | undefined
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined

    const onAbort = () => {
      // abort 路径：reader.cancel 失败无关紧要（请求已被中止，流要丢弃），吞错即可
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
        onActivity?.()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const raw of lines) {
          const line = raw.trim()
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') {
            flushToolCallDeltas()
            return { content: full, reasoning, toolCalls: finalizeToolCalls(toolCallByIndex), finishReason, usage }
          }
          try {
            const json = JSON.parse(data) as StreamChunk
            // token 用量：服务端通常在最后一个 chunk 返回 usage（可能无 choices）
            const parsed = parseUsage(json.usage)
            if (parsed) usage = parsed
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

            // 推理/思考过程增量（部分模型如 qwen 会在 delta.reasoning_content 中返回）
            const reasoningDelta = delta.reasoning_content
            if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
              reasoning += reasoningDelta
              handlers.onReasoningDelta?.(reasoningDelta)
            }

            // tool_calls 增量聚合（OpenAI 把一次调用拆成多段发送）
            const deltaToolCalls = delta.tool_calls
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
    return { content: full, reasoning, toolCalls: finalizeToolCalls(toolCallByIndex), finishReason, usage }
  }

  /** 批量向量化（OpenAI 兼容 /v1/embeddings） */
  async embed(texts: string[], model: string): Promise<number[][]> {
    // 同一道闸门：批量向量化（后台索引）与查询向量化（前台检索）都从这里出去，
    // 谁在提这个请求由 runInSlotKind 的作用域决定，不由调用点自觉决定
    return withLocalSlot({ baseUrl: this.baseUrl, lane: 'embedding', label: model }, () =>
      this.embedInner(texts, model)
    )
  }

  private async embedInner(texts: string[], model: string): Promise<number[][]> {
    const errors: string[] = []
    for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
      const key = this.nextKey()
      try {
        const res = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: this.authHeaders(key),
          body: JSON.stringify({ model, input: texts }),
          // 后台索引同样不能被一个挂死的 embedding 端点永久占住队列（同 listModels 的总时长口径）
          signal: AbortSignal.timeout(REQUEST_TOTAL_TIMEOUT_MS),
          ...NO_REDIRECT
        })
        assertNoRedirect(res)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if ((res.status === 401 || res.status === 403 || res.status === 429) && attempt < this.apiKeys.length - 1) {
            errors.push(`HTTP ${res.status}`)
            continue
          }
          throw new ProviderError(
            `向量化失败 HTTP ${res.status}: ${redactSecretsInText(text).slice(0, 200)}`,
            res.status
          )
        }
        const json = (await res.json()) as EmbeddingsResponse
        const data = json.data ?? []
        // OpenAI 规范保证按 input 顺序返回，但保险起见按 index 排序
        data.sort((a, b) => a.index - b.index)
        return data.map((d) => d.embedding)
      } catch (e) {
        if (e instanceof ProviderError) throw e
        errors.push(errMsg(e))
      }
    }
    throw new ProviderError(`向量化失败: ${errors.join('; ') || '无可用 Key'}`)
  }

  /** 图像生成（OpenAI Images 兼容 /v1/images/generations，n 固定 1）。
   *  兼容两种响应形态：data[0].b64_json（直接返回）与 data[0].url（由调用方下载）。 */
  async generateImages(params: {
    model: string
    prompt: string
    size: string
    signal?: AbortSignal
  }): Promise<{ b64?: string; url?: string }> {
    return withLocalSlot(
      { baseUrl: this.baseUrl, lane: 'image', label: params.model, signal: params.signal },
      () => this.generateImagesInner(params)
    )
  }

  private async generateImagesInner(params: {
    model: string
    prompt: string
    size: string
    signal?: AbortSignal
  }): Promise<{ b64?: string; url?: string }> {
    const body = JSON.stringify({
      model: params.model,
      prompt: params.prompt,
      size: params.size,
      n: 1
    })
    const errors: string[] = []
    for (let attempt = 0; attempt < Math.max(1, this.apiKeys.length); attempt++) {
      const key = this.nextKey()
      try {
        const res = await fetch(`${this.baseUrl}/images/generations`, {
          method: 'POST',
          headers: this.authHeaders(key),
          body,
          signal: params.signal,
          ...NO_REDIRECT
        })
        assertNoRedirect(res)
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if ((res.status === 401 || res.status === 403 || res.status === 429) && attempt < this.apiKeys.length - 1) {
            errors.push(`HTTP ${res.status}`)
            continue
          }
          throw new ProviderError(
            `图像生成失败 HTTP ${res.status}: ${redactSecretsInText(text).slice(0, 200)}`,
            res.status
          )
        }
        const json = (await res.json()) as ImagesGenerationResponse
        const item = json.data?.[0]
        if (!item) throw new ProviderError('响应中没有图片数据')
        if (typeof item.b64_json === 'string' && item.b64_json) return { b64: item.b64_json }
        if (typeof item.url === 'string' && item.url) return { url: item.url }
        throw new ProviderError('响应中既无 b64_json 也无 url')
      } catch (e) {
        if (e instanceof ProviderError) throw e
        if (isAbortError(e)) throw e
        errors.push(errMsg(e))
      }
    }
    throw new ProviderError(`图像生成失败: ${errors.join('; ') || '无可用 Key'}`)
  }
}

/** 把聚合的工具调用整理成最终 ToolCall 数组（丢弃空 ID 的） */
export function finalizeToolCalls(map: Map<number, AggregatedToolCall>): ToolCall[] | undefined {
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

/** 解析流式响应中的 usage（total_tokens 缺失时视为无效）。
 *  缓存命中数取 Anthropic 风格 cache_read_input_tokens，缺省回退 OpenAI 风格
 *  prompt_tokens_details.cached_tokens；两者都没有则 undefined。导出供测试。 */
export function parseUsage(
  raw: unknown
): { promptTokens: number; completionTokens: number; totalTokens: number; cachedTokens?: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const u = raw as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
    cache_read_input_tokens?: unknown
    prompt_tokens_details?: { cached_tokens?: unknown } | null
  }
  if (typeof u.total_tokens !== 'number') return undefined
  const cachedAnthropic = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : undefined
  const cachedOpenai = typeof u.prompt_tokens_details?.cached_tokens === 'number' ? u.prompt_tokens_details.cached_tokens : undefined
  const cachedTokens = cachedAnthropic ?? cachedOpenai
  return {
    promptTokens: typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0,
    completionTokens: typeof u.completion_tokens === 'number' ? u.completion_tokens : 0,
    totalTokens: u.total_tokens,
    ...(cachedTokens !== undefined ? { cachedTokens } : {})
  }
}
