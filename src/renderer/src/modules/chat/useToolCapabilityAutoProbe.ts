// 工具调用能力：首次选中某台模型时自动探一次（P0-4b）
//
// 自动探测的两个边界：
//  · **每台模型每个进程只自动问一次**（`attempted`）。探针失败不落库，若不记这一笔，
//    每次切回来都会再花 3 次请求；用户明确点「测一下」仍然可以随时重测。
//  · 已经有结论（含用户点过「跳过」）就只读台账，**不问也不发生请求**。
//
// 探测本身走用户自己的 Key（3 次请求，计入额度），所以界面必须写明费用；
// 本 hook 只负责状态，不替界面决定措辞。
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  toolCapabilityKey,
  type ToolCapabilityView,
  type ToolProbeFailure,
  type ToolProbeResult
} from '../../../../shared/tool-capability'
import { hasIpcFailed, ipcFailText } from '../../utils/ipc'

/** 进程级：自动探测只对每台模型跑一次（失败也不重复烧额度） */
const attempted = new Set<string>()

export interface ToolCapabilityAutoProbeState {
  capability: ToolCapabilityView | null
  probing: boolean
  failure: ToolProbeFailure | null
  /** IPC 层失败（主进程不可用等）：与"探针没跑完"分开说 */
  ipcError: string
  probe: () => void
  stop: () => void
  skip: () => void
}

export function useToolCapabilityAutoProbe(providerId: string, model: string): ToolCapabilityAutoProbeState {
  const key = providerId && model ? toolCapabilityKey(providerId, model) : ''
  const [capability, setCapability] = useState<ToolCapabilityView | null>(null)
  const [probing, setProbing] = useState(false)
  const [failure, setFailure] = useState<ToolProbeFailure | null>(null)
  const [ipcError, setIpcError] = useState('')
  const keyRef = useRef(key)
  keyRef.current = key
  const runningRef = useRef(false)
  /** 哪台模型正在被"跳过"：它自己掐断的那一发回来时不许覆盖 user_skipped */
  const skipRef = useRef('')

  const loadList = useCallback(async (): Promise<ToolCapabilityView[] | null> => {
    const api = window.pocketai as unknown as {
      listToolCapabilities?: () => Promise<ToolCapabilityView[] | { ok: false; error: string }>
    }
    if (typeof api?.listToolCapabilities !== 'function') return null
    try {
      const r = await api.listToolCapabilities()
      if (hasIpcFailed(r)) {
        setIpcError(ipcFailText(r, ''))
        return null
      }
      return r as ToolCapabilityView[]
    } catch (e) {
      setIpcError(e instanceof Error ? e.message : String(e))
      return null
    }
  }, [])

  const runProbe = useCallback(async (): Promise<void> => {
    if (!key || runningRef.current) return
    const api = window.pocketai as unknown as {
      probeToolCapability?: (providerId: string, model: string) => Promise<ToolProbeResult | { ok: false; error: string }>
    }
    const targetKey = key
    if (typeof api?.probeToolCapability !== 'function') return
    runningRef.current = true
    setProbing(true)
    setFailure(null)
    setIpcError('')
    try {
      const r = await api.probeToolCapability(providerId, model)
      if (keyRef.current !== targetKey) return
      if (hasIpcFailed(r)) {
        setIpcError(ipcFailText(r, ''))
        return
      }
      const out = r as ToolProbeResult
      // 用户点「跳过」时是我们自己掐断的这一发：结论保持原样（或等 skip 写入），
      // 不能把 probe_aborted 当成一次新判定画上去。
      if (out.error?.code === 'probe_aborted') {
        if (skipRef.current !== targetKey) setFailure(out.error)
        return
      }
      setCapability({ ...out.entry, stale: false })
      setFailure(out.error)
    } catch (e) {
      if (keyRef.current === targetKey) setIpcError(e instanceof Error ? e.message : String(e))
    } finally {
      runningRef.current = false
      if (keyRef.current === targetKey) setProbing(false)
    }
  }, [key, providerId, model])

  const probe = useCallback((): void => {
    // 手动重测允许越过"本进程已问过一次"的限制
    skipRef.current = ''
    attempted.add(key)
    void runProbe()
  }, [key, runProbe])

  const stop = useCallback((): void => {
    const api = window.pocketai as unknown as {
      abortToolProbe?: (providerId: string, model: string) => Promise<unknown>
    }
    if (typeof api?.abortToolProbe === 'function') void api.abortToolProbe(providerId, model)
  }, [providerId, model])

  const skip = useCallback((): void => {
    const api = window.pocketai as unknown as {
      skipToolProbe?: (providerId: string, model: string) => Promise<ToolCapabilityView | { ok: false; error: string }>
    }
    const skipFn = api?.skipToolProbe
    if (!key || typeof skipFn !== 'function') return
    skipRef.current = key
    attempted.add(key)
    void (async () => {
      // 先把在飞的那一发停掉：跳过之后不该继续烧用户的额度
      stop()
      try {
        const r = await skipFn(providerId, model)
        if (keyRef.current !== key) return
        if (hasIpcFailed(r)) {
          setIpcError(ipcFailText(r, ''))
          return
        }
        setCapability({ ...(r as ToolCapabilityView), stale: false })
        setFailure(null)
        setProbing(false)
      } catch (e) {
        if (keyRef.current === key) setIpcError(e instanceof Error ? e.message : String(e))
      }
    })()
  }, [key, providerId, model, stop])

  useEffect(() => {
    setCapability(null)
    setFailure(null)
    setIpcError('')
    if (!key) return
    let alive = true
    void (async () => {
      const list = await loadList()
      if (!alive) return
      const found = list?.find((e) => e.key === key)
      if (found) {
        setCapability(found)
        return
      }
      if (attempted.has(key)) return
      attempted.add(key)
      await runProbe()
    })()
    return () => {
      alive = false
    }
  }, [key, loadList, runProbe])

  return { capability, probing, failure, ipcError, probe, stop, skip }
}
