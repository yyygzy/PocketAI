// 统一的「复制」按钮：clipboard API + textarea 降级 + 「已复制」反馈
// 复制与反馈逻辑收口在 utils/clipboard + hooks/useCopyFeedback
import React from 'react'
import { useI18n } from '../i18n'
import { useCopyFeedback } from '../hooks/useCopyFeedback'

interface Props {
  text: string
  className?: string
  /** 按钮标题（hover tooltip），默认同「复制」文案 */
  title?: string
  /** 复制成功后的反馈持续毫秒数，默认 1500 */
  feedbackMs?: number
}

export const CopyButton: React.FC<Props> = ({
  text,
  className,
  title,
  feedbackMs = 1500
}) => {
  const { t } = useI18n()
  const { copied, copy } = useCopyFeedback(feedbackMs)

  return (
    <button
      onClick={() => void copy(text)}
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
