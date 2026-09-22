// 统一的「复制」按钮：处理 clipboard API + textarea 降级 + 「已复制」反馈
import React, { useCallback, useRef, useState } from 'react'
import { useI18n } from '../i18n'

interface Props {
  text: string
  className?: string
  /** 按钮标题（hover tooltip），默认同「复制」文案 */
  title?: string
  /** 复制成功后的反馈持续毫秒数，默认 1500 */
  feedbackMs?: number
}

/** 把文本写入剪贴板；clipboard API 在 file:// 等场景失败时降级到 execCommand */
async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    return
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      document.execCommand('copy')
    } finally {
      document.body.removeChild(ta)
    }
  }
}

export const CopyButton: React.FC<Props> = ({
  text,
  className,
  title,
  feedbackMs = 1500
}) => {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleCopy = useCallback(async () => {
    if (!text) return
    await writeClipboard(text)
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), feedbackMs)
  }, [text, feedbackMs])

  // 卸载时清理定时器
  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  return (
    <button
      onClick={() => void handleCopy()}
      title={title ?? t('common.copy')}
      className={
        className ??
        'text-[11px] px-1.5 py-0.5 rounded text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors'
      }
    >
      {copied ? t('common.copied') : t('common.copy')}
    </button>
  )
}
