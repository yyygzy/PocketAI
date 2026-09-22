// Provider / Assistant 基础数据加载与模型列表手动拉取
import { useCallback, useEffect, useState } from 'react'
import type { AssistantRecord, ProviderRecord } from '../../../../../shared/types'

export function useProviderData() {
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)

  useEffect(() => {
    void Promise.all([window.pocketai.listProviders(), window.pocketai.listAssistants()]).then(([ps, as_]) => {
      setProviders(ps.filter((p) => p.enabled))
      setAssistants(as_)
    })
  }, [])

  /** 手动重新拉取某个 Provider 的模型列表；失败不阻断（设置页有完整报错） */
  const fetchModels = useCallback(async (providerId: string) => {
    if (!providerId || fetchingModels) return
    setFetchingModels(true)
    try {
      const models = await window.pocketai.fetchModels(providerId)
      setProviders((prev) => prev.map((p) => (p.id === providerId ? { ...p, models } : p)))
    } catch {
      // 拉取失败静默（Provider 配置问题在设置页有完整报错）
    } finally {
      setFetchingModels(false)
    }
  }, [fetchingModels])

  return { providers, assistants, fetchingModels, fetchModels }
}
