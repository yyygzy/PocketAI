// Provider / Assistant 基础数据加载与模型列表手动拉取
import { useCallback, useEffect, useState } from 'react'
import type { AssistantRecord, ProviderRecord } from '../../../../../shared/types'
import { errText } from '../../../utils/error'
import { hasIpcFailed, reportIpcError } from '../../../utils/ipc'
import { useAppStore } from '../../../store/app-store'

export function useProviderData() {
  const [providers, setProviders] = useState<ProviderRecord[]>([])
  const [assistants, setAssistants] = useState<AssistantRecord[]>([])
  // §261：这两发各挂自己的"读不到"。失败侧不写 state（上一份是同一个全局清单 ⇒ 保持），只把那句说出来
  const [providersUnread, setProvidersUnread] = useState<{ error?: string } | null>(null)
  const [assistantsUnread, setAssistantsUnread] = useState<{ error?: string } | null>(null)
  const [fetchingModels, setFetchingModels] = useState(false)

  const load = useCallback(() => {
    // Promise.all 任一 reject 整体 reject，必须挂 .catch 否则未处理 rejection 穿透
    void Promise.all([window.pocketai.listProviders(), window.pocketai.listAssistants()]).then(([ps, as_]) => {
      // 逐发判（§257／§259 的口径）：以前这两行是"拿到就写"，而 safeHandle 的失败是 resolve 的
      // `{ok:false}` ⇒ ① `ps.filter` 当场 TypeError，被下面那句 .catch 当成"通道失败"念进 console，
      // **assistants 明明读到了也一起丢**（探针实测两份都是空数组）；
      // ② assistants 那发失败时对象被原样写进 state ⇒ `SessionRail` 的 `assistants.map is not a function`，
      // 整屏一个字都不剩（探针实测 body 长度 0＝真应用里的整站崩溃屏）。
      if (hasIpcFailed(ps) || !Array.isArray(ps)) {
        setProvidersUnread({ error: hasIpcFailed(ps) ? ps.error : undefined })
      } else {
        setProvidersUnread(null)
        setProviders(ps.filter((p) => p.enabled))
      }
      if (hasIpcFailed(as_) || !Array.isArray(as_)) {
        setAssistantsUnread({ error: hasIpcFailed(as_) ? as_.error : undefined })
      } else {
        setAssistantsUnread(null)
        setAssistants(as_)
      }
    }).catch((e: unknown) => {
      // reject 面（通道真抛了）：两份都算没读到，保持上一份＋点名
      reportIpcError('agent.loadProviderData')(e)
      const error = errText(e, '')
      setProvidersUnread({ error })
      setAssistantsUnread({ error })
    })
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

  return { providers, assistants, providersUnread, assistantsUnread, fetchingModels, fetchModels }
}
