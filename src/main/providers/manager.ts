// Provider 管理器：从 DB 加载配置 → 构造适配器 → 缓存
import { providerRepo } from '../db/repositories/provider.repo'
import { OpenAICompatibleAdapter } from './openai-compatible'
import { AnthropicNativeAdapter } from './anthropic-native'
import { GeminiNativeAdapter } from './gemini-native'
import { normalizeBaseUrl, type ProviderAdapter } from './types'
import { errMsg } from '../error'
import { redactSecretsInText } from '../security/audit-redact'
import type { ProviderRecord } from '../../shared/types'

class ProviderManager {
  private adapters = new Map<string, ProviderAdapter>()
  /**
   * Ollama keep_alive 读取器，由主进程入口注入（避免本模块顶层拉入 app_config → portable → electron
   * 依赖链，那会让纯 manager 测试在无 electron mock 时崩）。未注入时返回 undefined＝不下发。
   */
  private keepAliveResolver: () => string | undefined = () => undefined

  /**
   * 隐私模式守卫，由主进程入口注入（与 keepAlive 同理，避免本模块顶层拉入 app_config → electron 链）。
   * 默认 () => true＝放行，纯 manager 测试无需 electron mock；真实运行时由 registerOllamaHandlers 注入判定。
   */
  private privacyGuardResolver: (id: string) => boolean = () => true

  setPrivacyGuardResolver(fn: (id: string) => boolean): void {
    this.privacyGuardResolver = fn
    this.adapters.clear()
  }

  setKeepAliveResolver(fn: () => string | undefined): void {
    this.keepAliveResolver = fn
    // 已缓存的 ollama adapter 拿不到新配置：清掉让下次 getAdapter 重建
    this.adapters.clear()
  }

  /** 获取（或创建）某 Provider 的适配器 */
  getAdapter(id: string): ProviderAdapter {
    const cached = this.adapters.get(id)
    if (cached) return cached

    const record = providerRepo.get(id)
    if (!record) throw new Error(`Provider 不存在: ${id}`)
    if (!record.enabled) throw new Error(`Provider 已禁用: ${record.name}`)
    // 隐私模式纵深：所有 LLM 出口（主对话/规划/摘要/降级/拉取模型）都过 getAdapter，
    // 在这里拒绝云端，覆盖任何绕过 engine.run() 主闸门的调用路径。
    if (!this.privacyGuardResolver(id)) {
      throw new Error('PRIVACY_MODE_BLOCKED_CLOUD:隐私模式已开启，禁止向云端模型发送数据')
    }

    const baseUrl = normalizeBaseUrl(record.baseUrl)
    // Anthropic / Gemini 走各自原生协议：真实 tool_use / functionCall 形状与 token 用量，
    // 不再靠 OpenAI 兼容层猜字段。其余类型（含 ollama）仍走 OpenAI 兼容端点。
    let adapter: ProviderAdapter
    if (record.type === 'anthropic') {
      adapter = new AnthropicNativeAdapter(baseUrl, record.apiKeys)
    } else if (record.type === 'gemini') {
      adapter = new GeminiNativeAdapter(baseUrl, record.apiKeys)
    } else {
      adapter = new OpenAICompatibleAdapter(
        baseUrl,
        record.apiKeys,
        false,
        // 只有本地 Ollama 才带 keep_alive（让模型驻留内存命中 prefix cache）；
        // 其他 OpenAI 兼容端点不认这个字段，绝不污染。
        record.type === 'ollama' ? this.keepAliveResolver() : undefined
      )
    }
    this.adapters.set(id, adapter)
    return adapter
  }

  getRecord(id: string): ProviderRecord {
    const record = providerRepo.get(id)
    if (!record) throw new Error(`Provider 不存在: ${id}`)
    return record
  }

  /** 拉取远端模型列表并写回 DB 缓存 */
  async fetchModels(id: string): Promise<string[]> {
    const adapter = this.getAdapter(id)
    const models = await adapter.listModels()
    providerRepo.updateModels(id, models)
    this.invalidate(id) // 模型列表变化不影响 adapter，但保险起见刷新
    return models
  }

  /** 测试连通性 */
  async test(
    id: string
  ): Promise<{ ok: boolean; modelCount?: number; error?: string }> {
    try {
      const models = await this.fetchModels(id)
      return { ok: true, modelCount: models.length }
    } catch (e) {
      // test 结果直接回渲染层：上游错误体可能回显 API Key
      return { ok: false, error: redactSecretsInText(errMsg(e)) }
    }
  }

  invalidate(id?: string): void {
    if (id) this.adapters.delete(id)
    else this.adapters.clear()
  }
}

export const providerManager = new ProviderManager()
