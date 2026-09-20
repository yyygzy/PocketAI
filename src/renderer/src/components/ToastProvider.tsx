// 全局 Toast 通知体系：统一替代散落的 alert() / window.alert()
// —— 多条堆叠、按类型着色（info/success/error/warning）、点击关闭、自动消失
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

type ToastKind = 'info' | 'success' | 'error' | 'warning'

interface ToastItem {
  id: number
  kind: ToastKind
  message: string
}

interface ToastApi {
  info: (msg: string) => void
  success: (msg: string) => void
  error: (msg: string) => void
  warning: (msg: string) => void
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastApi | null>(null)

const KIND_STYLE: Record<ToastKind, string> = {
  info: 'bg-[var(--color-info-bg)] text-[var(--color-info)] border-[var(--color-info)]',
  success: 'bg-[var(--color-success-bg)] text-[var(--color-success)] border-[var(--color-success)]',
  error: 'bg-[var(--color-danger-bg)] text-[var(--color-danger)] border-[var(--color-danger)]',
  warning: 'bg-[var(--color-warning-bg)] text-[var(--color-warning)] border-[var(--color-warning)]'
}

// 错误类需要更长时间阅读
const KIND_DURATION: Record<ToastKind, number> = {
  info: 2500,
  success: 2500,
  warning: 3500,
  error: 4500
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const idRef = useRef(0)
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map())

  const dismiss = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++idRef.current
      setItems((prev) => [...prev, { id, kind, message }])
      const timer = setTimeout(() => dismiss(id), KIND_DURATION[kind])
      timersRef.current.set(id, timer)
    },
    [dismiss]
  )

  // 组件卸载时清掉所有未触发的定时器，避免对已卸载组件 setState
  const cleanupRef = useRef<() => void>(() => {
    timersRef.current.forEach((t) => clearTimeout(t))
    timersRef.current.clear()
  })
  useEffect(() => () => cleanupRef.current(), [])

  // 保持引用稳定：push/dismiss 均为 useCallback，api 经 useMemo 固化，
  // 消费者可安全把 toast 放进 useCallback 依赖数组，且 toast 显隐不会引发全树重渲染
  const api = useMemo<ToastApi>(
    () => ({
      info: (m) => push('info', m),
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      warning: (m) => push('warning', m),
      dismiss
    }),
    [push, dismiss]
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="fixed bottom-6 right-6 z-[10000] flex flex-col gap-2 pointer-events-none">
        {items.map((it) => (
          <div
            key={it.id}
            role="status"
            onClick={() => dismiss(it.id)}
            className={`pointer-events-auto cursor-pointer whitespace-pre-line rounded-lg border px-4 py-2.5 text-sm max-w-sm break-words shadow-lg ${KIND_STYLE[it.kind]}`}
          >
            {it.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
