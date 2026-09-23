// 行内瞬时提示统一收口：替代各模块自管的 setToast/setNotice + setTimeout 重复实现。
// show(value) 展示并在 durationMs 后自动清空，连续 show 重置计时；clear() 立即清空；
// 组件卸载自动清理定时器，避免卸载后 setState（裸 setTimeout 版本的共同隐患）。
import { useCallback, useEffect, useRef, useState } from 'react'

export function useTransientNotice<T>(durationMs: number) {
  const [notice, setNotice] = useState<T | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const show = useCallback(
    (value: T) => {
      setNotice(value)
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = null
        setNotice(null)
      }, durationMs)
    },
    [durationMs, clearTimer]
  )

  const clear = useCallback(() => {
    clearTimer()
    setNotice(null)
  }, [clearTimer])

  useEffect(() => clearTimer, [clearTimer])

  return { notice, show, clear }
}
