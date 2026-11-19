// Provider 启用集的共享单一出口（模型启用与两级选择方案 §2.4 / §5.1）。
//
// 所有「对话类」消费点（对话主链路、浮窗、助手默认模型、渠道模型）必须通过
// enabledModelsOf 取可选模型，禁止再直接读 p.models；
// 知识库嵌入/重排/OCR、图像、翻译继续用全量 p.models，不走这里。
import type { ProviderRecord } from './types'

/**
 * 该服务商当前可选（已启用）的模型列表。
 *  - enabledModels == null：未配置 ⇒ 全部 models 启用（老库升级零感知）
 *  - enabledModels == []：明确全部停用 ⇒ 空列表
 *  - 否则：与 models 求交集，顺序永远跟 models 走，自动裁剪已失效的白名单项
 */
export function enabledModelsOf(p: Pick<ProviderRecord, 'models' | 'enabledModels'>): string[] {
  if (p.enabledModels == null) return p.models ?? [] // 缺 models 字段的脏记录不把界面带崩
  const set = new Set(p.enabledModels)
  return (p.models ?? []).filter((m) => set.has(m))
}
