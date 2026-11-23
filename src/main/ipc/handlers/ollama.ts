// Ollama 便携运行时 IPC：安装/启停/拉模型/镜像源
import { IPC, type SystemOneRequest } from '../../../shared/types'
import { ollamaRuntime } from '../../ollama/ollama-runtime'
import { getOllamaKeepAlive, setOllamaKeepAlive } from '../../ollama/keepalive-config'
import { isProviderAllowedUnderPrivacy } from '../../agent/privacy-prefs'
import { runSystemOne } from '../../ollama/systemone'
import { createContextModel } from '../../ollama/create-context-model'
import { setModelContextWindow } from '../../agent/model-window-prefs'
import { providerRepo } from '../../db/repositories/provider.repo'
import { providerManager } from '../../providers/manager'
import { broadcast } from '../broadcast'
import { safeHandle, argsSchema, z } from '../safe-handle'

/**
 * 拉取模型成功后，确保存在指向本地 11434 的 Ollama provider 并包含该模型。
 * 用户已手动配置过（含 LM Studio 等其他本地端口）时不动其记录，只补缺失的 ollama 条目。
 */
function ensureOllamaProvider(model: string): string {
  const localBaseUrl = 'http://localhost:11434/v1'
  const existing = providerRepo.list().find((p) => p.type === 'ollama' && p.baseUrl.includes('11434'))
  if (existing) {
    if (!existing.models.includes(model)) {
      providerRepo.updateModels(existing.id, [...existing.models, model])
    }
    return existing.id
  }
  return providerRepo.save({
    id: '',
    type: 'ollama',
    name: 'Ollama（本地模型）',
    baseUrl: localBaseUrl,
    apiKeys: [],
    models: [model],
    enabled: true,
    createdAt: Date.now()
  }).id
}

export function registerOllamaHandlers(): void {
  // 把 keep_alive 读取器注入 provider manager：manager 本身不碰 DB，
  // 这里才把 app_config 依赖接进来（纯 manager 测试无需 electron mock）。
  providerManager.setKeepAliveResolver(() => getOllamaKeepAlive())
  // 隐私模式守卫注入：providerManager 本身不碰 app_config，这里才把判定接进来（纯 manager 测试无 electron 依赖）
  providerManager.setPrivacyGuardResolver((id) => isProviderAllowedUnderPrivacy(id))
  safeHandle(IPC.OLLAMA_GET_STATUS, () => ollamaRuntime.getStatus())
  safeHandle(IPC.OLLAMA_INSTALL, async () =>
    ollamaRuntime.install((e) => broadcast(IPC.OLLAMA_EVENT, e))
  )
  safeHandle(IPC.OLLAMA_START, async () => {
    await ollamaRuntime.start()
    return { ok: true, status: await ollamaRuntime.getStatus() }
  })
  safeHandle(IPC.OLLAMA_STOP, async () => {
    await ollamaRuntime.stop()
    return { ok: true }
  })
  safeHandle(IPC.OLLAMA_LIST_MODELS, () => ollamaRuntime.listModels())
  safeHandle(IPC.OLLAMA_PULL, async (_e, model: string) => {
    const name = String(model ?? '').trim()
    if (!name) return { ok: false, error: '模型名不能为空' }
    await ollamaRuntime.pullModel(name, (e) => broadcast(IPC.OLLAMA_PULL_EVENT, e))
    // 拉取成功：确保存在指向本地 11434 的 ollama provider，并把新模型加入模型列表
    ensureOllamaProvider(name)
    return { ok: true }
  }, argsSchema(z.string().min(1)))
  safeHandle(IPC.OLLAMA_PULL_ABORT, () => {
    ollamaRuntime.abortPull()
    return { ok: true }
  })
  safeHandle(IPC.OLLAMA_MIRROR_GET, () => ({ ok: true, mirror: ollamaRuntime.getMirror() }))
  safeHandle(IPC.OLLAMA_MIRROR_SET, (_e, prefix: string) => {
    ollamaRuntime.setMirror(String(prefix ?? ''))
    return { ok: true }
  }, argsSchema(z.string()))
  // keep_alive 配置：让本地模型驻留内存命中 prefix cache；仅 ollama provider 下发。
  safeHandle(IPC.OLLAMA_KEEPALIVE_GET, () => ({ ok: true, keepAlive: getOllamaKeepAlive() ?? '' }))
  safeHandle(IPC.OLLAMA_KEEPALIVE_SET, (_e, value: string) => {
    if (!setOllamaKeepAlive(String(value ?? ''))) {
      return { ok: false, error: '驻留时间格式不正确（示例：10m / 24h / -1，留空恢复默认）' }
    }
    // 已缓存的 ollama adapter 是旧配置构造的，清掉让下次请求重建后带上新 keep_alive
    providerManager.invalidate()
    return { ok: true }
  }, argsSchema(z.string()))
  // Jev 决策模型：Ollama ≥0.35 的 /v1/systemone，直连本地 11434；入参结构先由 zod 挡一道
  safeHandle(IPC.OLLAMA_SYSTEMONE, async (_e, req: SystemOneRequest) => runSystemOne(req), argsSchema(z.object({
    model: z.string().min(1),
    state: z.record(z.string(), z.string()),
    questions: z.record(z.string(), z.object({
      type: z.enum(['choice', 'noul', 'score']),
      instructions: z.string().min(1),
      criteria: z.union([z.record(z.string(), z.string()), z.array(z.string())]).optional()
    }))
  })))
  // 大上下文衍生模型：native /api/create 派生后，把新模型加入 provider 并写入 model-window，
  // 让引擎按这个窗口裁历史（本地端点不吃内置窗口表，必须显式配置）。
  safeHandle(
    IPC.OLLAMA_CREATE_CONTEXT_MODEL,
    async (_e, req: { from: string; model: string; numCtx: number }) => {
      const result = await createContextModel(req)
      if (!result.ok) return result
      const providerId = ensureOllamaProvider(req.model.trim())
      const { windows, rejected } = setModelContextWindow(providerId, req.model.trim(), req.numCtx)
      return {
        ok: true,
        providerId,
        model: req.model.trim(),
        numCtx: req.numCtx,
        windows,
        windowRejected: rejected ?? null
      }
    },
    argsSchema(z.object({
      from: z.string().min(1),
      model: z.string().min(1),
      numCtx: z.number().int().min(2048).max(1_048_576)
    }))
  )
}
