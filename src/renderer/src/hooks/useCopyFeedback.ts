// 「复制 + 已复制瞬时反馈」统一 hook
//
// 收口历史上 ImageModule / TranslateModule / CopyButton 各自维护的
// copied 状态 + 定时器 + 卸载清理样板。
//
// 默认走 utils/clipboard.writeClipboard（含 textarea 降级）。
// 敏感剪贴板（恢复码等，走主进程 IPC copySensitiveToClipboard 并自动过期）
// 可传自定义 writer：(text) => Promise<boolean>。
import { useCallback, useEffect, useRef, useState } from 'react'
import { writeClipboard } from '../utils/clipboard'

export type CopyWriter = (text: string) => Promise<boolean>

export interface UseCopyFeedback {
  /** 是否处于「已复制」反馈态（feedbackMs 后自动复位） */
  copied: boolean
  /** 执行复制；空字符串直接返回 false，剪贴板写入失败不置反馈态 */
  copy: (text: string) => Promise<boolean>
}

export function useCopyFeedback(
  feedbackMs = 1500,
  writer: CopyWriter = writeClipboard
): UseCopyFeedback {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const copy = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text) return false
      const ok = await writer(text)
      if (ok) {
        setCopied(true)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(false), feedbackMs)
      }
      return ok
    },
    [feedbackMs, writer]
  )

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    },
    []
  )

  return { copied, copy }
}
