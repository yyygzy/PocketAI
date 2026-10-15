// Ollama 本地 API 载荷的纯解析（V4-Iter-140）
//
// 为什么单独成文件：ollama-runtime.ts 依赖 electron/portable，测试里通常整模块打桩，
// 解析逻辑住在那儿就等于测不到（同 V4-Iter-123 那条「纯函数别寄居在被普遍打桩的模块里」）。
//
// 为什么要 `size`：V-0 实测 `/api/tags` 本来就把体积与量化给出（3b Q4_K_M 1,929,912,432B），
// 而原先的读取只留 `name` —— 体积是拿到就丢，容量判据因此缺输入。
export interface OllamaModelDetail {
  name: string
  /** 权重文件体积（字节）。缺失时为 0，调用方须把 0 当"未告知"而不是"不占显存" */
  sizeBytes: number
  /** 镜像摘要，用于判据缓存的失效键（模型换了内容就得重探） */
  digest: string
  parameterSize: string
  quantizationLevel: string
}

/** `/api/ps` 的一条驻留记录 —— 注意 sizeVramBytes 是 Ollama 自己的记账，不等于实占（B72 反向对照钉这条） */
export interface OllamaLoadedModel {
  name: string
  sizeVramBytes: number
  /** ISO 字符串；缺失为 '' */
  expiresAt: string
}

const asFiniteNumber = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
const asString = (v: unknown): string => (typeof v === 'string' ? v : '')

export function parseOllamaTags(raw: unknown): OllamaModelDetail[] {
  const models = (raw as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const out: OllamaModelDetail[] = []
  for (const m of models) {
    const name = asString((m as { name?: unknown })?.name)
    if (!name) continue
    const details = (m as { details?: unknown })?.details as
      | { parameter_size?: unknown; quantization_level?: unknown }
      | undefined
    out.push({
      name,
      sizeBytes: asFiniteNumber((m as { size?: unknown })?.size),
      digest: asString((m as { digest?: unknown })?.digest),
      parameterSize: asString(details?.parameter_size),
      quantizationLevel: asString(details?.quantization_level)
    })
  }
  return out
}

export function parseOllamaPs(raw: unknown): OllamaLoadedModel[] {
  const models = (raw as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const out: OllamaLoadedModel[] = []
  for (const m of models) {
    const name = asString((m as { name?: unknown })?.name)
    if (!name) continue
    out.push({
      name,
      sizeVramBytes: asFiniteNumber((m as { size_vram?: unknown })?.size_vram),
      expiresAt: asString((m as { expires_at?: unknown })?.expires_at)
    })
  }
  return out
}
