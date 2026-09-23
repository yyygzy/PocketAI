// 统一确认弹窗 + useConfirm hook：替代原生 window.confirm。
// 原生 confirm 在 Electron 内样式突兀、阻塞渲染进程；本组件走应用内 modal，
// useConfirm 以 Promise 式调用保持原 `if (!await confirm(...)) return` 控制流。
import React, { useCallback, useState } from 'react'
import { useI18n } from '../i18n'

interface ConfirmDialogProps {
  open: boolean
  /** 确认提示文案（支持换行） */
  message: string
  /** 可选标题 */
  title?: string
  /** 确认按钮文案，默认 common.confirm */
  confirmText?: string
  /** 取消按钮文案，默认 common.cancel */
  cancelText?: string
  /** 危险动作（确认按钮用 danger 色） */
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  message,
  title,
  confirmText,
  cancelText,
  danger,
  onConfirm,
  onClose
}) => {
  const { t } = useI18n()
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-[var(--color-modal-overlay)] backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-2xl bg-[var(--color-surface)] border border-[var(--color-border)] p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h3 className="text-sm font-semibold mb-2">{title}</h3>}
        <p className="text-sm text-[var(--color-text-muted)] whitespace-pre-line break-words">{message}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded text-sm text-[var(--color-text-muted)] hover:bg-[var(--color-hover-overlay)] hover:text-[var(--color-text)] transition-colors"
          >
            {cancelText ?? t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={`px-3 py-1.5 rounded text-sm font-medium text-[var(--color-on-accent)] transition-colors ${
              danger ? 'bg-[var(--color-danger)] hover:opacity-90' : 'bg-[var(--color-accent)] hover:opacity-90'
            }`}
          >
            {confirmText ?? t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}

export interface ConfirmOptions {
  message: string
  title?: string
  danger?: boolean
  confirmText?: string
  cancelText?: string
}

/**
 * 以 Promise 式调用替代 window.confirm，保持原同步控制流。
 *
 * 用法：
 *   const { confirm, dialog } = useConfirm()
 *   // 在事件处理中：
 *   if (!await confirm({ message: t('xx.del'), danger: true })) return
 *   // 在组件树末尾渲染：{dialog}
 */
export function useConfirm(): { confirm: (opts: ConfirmOptions) => Promise<boolean>; dialog: React.ReactNode } {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  const confirm = useCallback((opts: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      setState({ ...opts, resolve })
    })
  }, [])

  const handleClose = useCallback(() => {
    state?.resolve(false)
    setState(null)
  }, [state])

  const handleConfirm = useCallback(() => {
    state?.resolve(true)
    setState(null)
  }, [state])

  const dialog = (
    <ConfirmDialog
      open={!!state}
      message={state?.message ?? ''}
      title={state?.title}
      danger={state?.danger}
      confirmText={state?.confirmText}
      cancelText={state?.cancelText}
      onClose={handleClose}
      onConfirm={handleConfirm}
    />
  )

  return { confirm, dialog }
}
