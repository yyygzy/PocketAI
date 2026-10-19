// Provider / Assistant 基础数据加载与模型列表手动拉取
import { useCallback, useEffect, useState } from 'react'
import type { AssistantRecord, ProviderRecord } from '../../../../../shared/types'
import { hasIpcFailed, reportIpcError } from '../../../utils/ipc'
import { useAppStore } from '../../../store/app-store'

export function useProviderData() {
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)

  const load = useCallback(() => {
    // Promise.all 任一 reject 整体 reject，必须挂 .catch 否则未处理 rejection 穿透
    void Promise.all([window.pocketai.listProviders(), window.pocketai.listAssistants()]).then(([ps, as_]) => {
      setProviders(ps.filter((p) => p.enabled))
      setAssistants(as_)
    }).catch(reportIpcError('agent.loadProviderData'))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 模块保活 ⇒ 切走再回来不会重挂：在设置里「拉取模型」或改服务商后回到 Agent，
  // 这里得重拉一次，否则模型下拉还停在旧列表（表现为"刚拉到的模型选不到"）。
  const activeModule = useAppStore((s) => s.activeModule)
  useEffect(() => {
    if (activeModule === 'agent') load()
  }, [activeModule, load])

  /** 手动重新拉取某个 Provider 的模型列表；失败不阻断（设置页有完整报错） */
  const fetchModels = useCallback(async (providerId: string) => {
    if (!providerId || fetchingModels) return
    setFetchingModels(true)
    try {
      const models = await window.pocketai.fetchModels(providerId)
      // §219：这一条的『失败静默』是写在注释里的既有决定，但静默不等于可以把 `{ok:false}` 当成模型列表写进 provider.models——下游 `.includes`／`.map` 会当场坏（V4-Iter-115 那条空盒子形状）
      if (hasIpcFailed(models)) return
      setProviders((prev) => prev.map((p) => (p.id === providerId ? { ...p, models } : p)))
    } catch {
      // 拉取失败静默（Provider 配置问题在设置页有完整报错）
    } finally {
      setFetchingModels(false)
    }
  }, [fetchingModels])

  return { providers, assistants, fetchingModels, fetchModels }
}
