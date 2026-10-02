// Ollama 模型拉取共用 hook：设置页 OllamaPanel 与管家页推荐卡片共用
// 同一条拉取链路（主进程全局单例，同一时刻只允许一个拉取任务）。
// 封装：事件订阅/清理、并发与空名守卫、成功回调、错误复位；组件卸载不中断后台拉取。
import { useCallback, useEffect, useRef, useState } from 'react'
import type { OllamaPullEvent } from '../../../shared/types'
import { reportIpcError } from '../utils/ipc'
import { errText } from '../utils/error'

/** 推荐卡片拉取按钮的派生状态（纯函数，供 UI 与单测共用） */
export type PickPullState = 'installed' | 'busy-other' | 'pulling' | 'disabled' | 'pullable'

export function pickPullState(args: {
  installed: boolean
  ollamaRunning: boolean
  pulling: string | null
  model: string
}): PickPullState {
  // 已装优先：极端情况下事件残留/同名任务进行中也不展示拉取态
  if (args.installed) return 'installed'
  if (args.pulling === args.model) return 'pulling'
  if (args.pulling !== null) return 'busy-other'
  if (!args.ollamaRunning) return 'disabled'
  return 'pullable'
}

export interface UseOllamaPullOptions {
  /** 拉取成功完成（pull 返回 ok）时回调，参数为模型名；调用方各自刷新 UI */
  onDone?: (model: string) => void
  /** 拉取失败（IPC !ok 或 reject）时回调，参数为模型名与已拼前缀的错误信息 */
  onError?: (model: string, message: string) => void
}

export function useOllamaPull(opts?: UseOllamaPullOptions) {
  const [pulling, setPulling] = useState<string | null>(null)
  const [pullEvt, setPullEvt] = useState<OllamaPullEvent | null>(null)
  const [error, setError] = useState('')
  // 回调放 ref，事件订阅只需挂载一次，不因调用方回调变化重订阅
  const onDoneRef = useRef<UseOllamaPullOptions['onDone']>(opts?.onDone)
  onDoneRef.current = opts?.onDone
  const onErrorRef = useRef<UseOllamaPullOptions['onError']>(opts?.onError)
  onErrorRef.current = opts?.onError

  useEffect(() => {
    const off = window.pocketai.onOllamaPullEvent((e) => setPullEvt(e))
    return off
  }, [])

  /** @returns 是否拉取成功（调用方据此清空输入框/弹 toast） */
  const pull = useCallback(async (model: string): Promise<boolean> => {
    const name = model.trim()
    if (!name || pulling !== null) return false
    setError('')
    setPulling(name)
    setPullEvt({ model: name, status: '', percent: 0, done: false })
    try {
      const r = await window.pocketai.pullOllamaModel(name)
      if (r.ok) {
        onDoneRef.current?.(name)
        return true
      }
      const msg = `${name}: ${r.error ?? 'pull failed'}`
      setError(msg)
      onErrorRef.current?.(name, msg)
      return false
    } catch (e) {
      // IPC 层 reject（主进程异常/通道失败）：必须复位 pulling，否则按钮永久卡在拉取中
      const msg = `${name}: ${errText(e)}`
      setError(msg)
      onErrorRef.current?.(name, msg)
      return false
    } finally {
      setPulling(null)
    }
  }, [pulling])

  const abort = useCallback(() => {
    window.pocketai.abortOllamaPull().catch(reportIpcError('ollama.abortPull'))
  }, [])

  return { pulling, pullEvt, error, pull, abort }
}
