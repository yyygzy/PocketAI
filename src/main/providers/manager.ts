// Provider 管理器：从 DB 加载配置 → 构造适配器 → 缓存
import { providerRepo } from '../db/repositories/provider.repo'
import { OpenAICompatibleAdapter } from './openai-compatible'
import { normalizeBaseUrl, type ProviderAdapter } from './types'
import type { ProviderRecord } from '../../shared/types'

class ProviderManager {
  private adapters = new Map<string, ProviderAdapter>()

  /** 获取（或创建）某 Provider 的适配器 */
  getAdapter(id: string): ProviderAdapter {
    const cached = this.adapters.get(id)
    if (cached) return cached

    const record = providerRepo.get(id)
    if (!record) throw new Error(`Provider 不存在: ${id}`)
    if (!record.enabled) throw new Error(`Provider 已禁用: ${record.name}`)

    // Phase 1：所有类型（含 ollama）均走 OpenAI 兼容端点
    // Phase 后续：gemini / anthropic 在此分派专用适配器
    const adapter = new OpenAICompatibleAdapter(
      normalizeBaseUrl(record.baseUrl),
      record.apiKeys
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
      return { ok: false, error: (e as Error).message }
    }
  }

  invalidate(id?: string): void {
    if (id) this.adapters.delete(id)
    else this.adapters.clear()
  }
}

export const providerManager = new ProviderManager()
