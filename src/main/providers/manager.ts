// Provider 管理器：从 DB 加载配置 → 构造适配器 → 缓存
import { providerRepo } from '../db/repositories/provider.repo'
import { OpenAICompatibleAdapter } from './openai-compatible'
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

    // Phase 1：所有类型（含 ollama）均走 OpenAI 兼容端点
    // Phase 后续：gemini / anthropic 在此分派专用适配器
    // Anthropic 型走 OpenAI 兼容层并启用 prompt caching（cache_control 断点降输入成本）
    const adapter = new OpenAICompatibleAdapter(
      normalizeBaseUrl(record.baseUrl),
      record.apiKeys,
      record.type === 'anthropic',
      // 只有本地 Ollama 才带 keep_alive（让模型驻留内存命中 prefix cache）；
      // 其他 OpenAI 兼容端点不认这个字段，绝不污染。
      record.type === 'ollama' ? this.keepAliveResolver() : undefined
    )
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
