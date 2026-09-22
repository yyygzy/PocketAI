// Agent 输入框附件：选择文件 / 拖拽 / 预览删除，最多 8 个
import { useCallback, useRef, useState } from 'react'
import type { ChatAttachment } from '../../../../../shared/types'
import { ATTACHMENT_ACCEPT, MAX_ATTACHMENTS, readFileAsAttachment } from '../agent-shared'

export function useAttachments() {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const addFiles = useCallback(async (files: ArrayLike<File>) => {
    const results = await Promise.all(Array.from(files).map(readFileAsAttachment))
    const valid = results.filter((r): r is ChatAttachment => r !== null)
    if (valid.length > 0) {
      setAttachments((prev) => [...prev, ...valid].slice(0, MAX_ATTACHMENTS))
    }
  }, [])

  const removeAt = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }, [])

  const clear = useCallback(() => setAttachments([]), [])
  const openPicker = useCallback(() => fileRef.current?.click(), [])

  /** 直接铺到隐藏 <input type="file"> 上的 props */
  const fileInputProps = {
    ref: fileRef,
    type: 'file' as const,
    multiple: true,
    accept: ATTACHMENT_ACCEPT,
    className: 'hidden',
    onChange: async (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) await addFiles(e.target.files)
      e.target.value = ''
    }
  }

  /** 直接铺到输入容器 div 上的拖拽 props */
  const dropZoneProps = {
    onDrop: async (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (e.dataTransfer.files) await addFiles(e.dataTransfer.files)
    },
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); setDragOver(true) },
    onDragLeave: () => setDragOver(false)
  }

  return {
    attachments,
    dragOver,
    addFiles,
    removeAt,
    clear,
    openPicker,
    fileInputProps,
    dropZoneProps
  }
}
