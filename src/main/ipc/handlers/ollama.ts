// Ollama 便携运行时 IPC：安装/启停/拉模型/镜像源
import { IPC } from '../../../shared/types'
import { ollamaRuntime } from '../../ollama/ollama-runtime'
import { providerRepo } from '../../db/repositories/provider.repo'
import { broadcast } from '../broadcast'
import { safeHandle, argsSchema, z } from '../safe-handle'

/**
 * 拉取模型成功后，确保存在指向本地 11434 的 Ollama provider 并包含该模型。
 * 用户已手动配置过（含 LM Studio 等其他本地端口）时不动其记录，只补缺失的 ollama 条目。
 */
function ensureOllamaProvider(model: string): void {
  const localBaseUrl = 'http://localhost:11434/v1'
  const existing = providerRepo.list().find((p) => p.type === 'ollama' && p.baseUrl.includes('11434'))
  if (existing) {
    if (!existing.models.includes(model)) {
      providerRepo.updateModels(existing.id, [...existing.models, model])
    }
    return
  }
  providerRepo.save({
    id: '',
    type: 'ollama',
    name: 'Ollama（本地模型）',
    baseUrl: localBaseUrl,
    apiKeys: [],
    models: [model],
    enabled: true,
    createdAt: Date.now()
  })
}

export function registerOllamaHandlers(): void {
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
}
