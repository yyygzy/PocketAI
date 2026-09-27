// 消息附件网格：图片缩略图（点击应用内放大）+ 文本类文件卡片
// Chat 与 Agent 历史消息共用，保证渲染一致；发送框内的待发缩略图由各自 Composer 处理
//
// 放大方案刻意不使用 window.open(data: URL)：主进程 setWindowOpenHandler 仅放行
// http/https（防 javascript:/file: 等协议），data: 会被静默拒绝，点击无反应。
// 改为应用内 lightbox overlay，对小白用户也更直观。
import React, { useEffect, useState } from 'react'
import type { ChatAttachment } from '../../../shared/types'

interface Props {
  attachments: ChatAttachment[]
  /** 对齐方向：用户消息 end（右），其他场景 start（左） */
  align?: 'start' | 'end'
}

/** 文件大小人类可读：<1KB 显示 B，否则保留 1 位小数 KB */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** 图片放大 overlay：点击遮罩或按 Esc 关闭，点击图片本身不关闭 */
export const ImageLightbox: React.FC<{ src: string; onClose: () => void }> = ({ src, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center cursor-zoom-out p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <img
        src={src}
        className="max-w-full max-h-full object-contain rounded cursor-default"
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

export const AttachmentGrid: React.FC<Props> = ({ attachments, align = 'end' }) => {
  /** 当前放大的图片 data URL；null 表示关闭 */
  const [zoomSrc, setZoomSrc] = useState<string | null>(null)

  if (attachments.length === 0) return null
  return (
    <>
      <div className={`flex flex-wrap gap-1.5 mt-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
        {attachments.map((att, i) =>
          att.type === 'image' ? (
            <img
              key={`${att.name}-${i}`}
              src={att.data}
              alt={att.name}
              title={att.name}
              className="w-20 h-20 object-cover rounded-lg border border-[var(--color-border)] cursor-zoom-in"
              onClick={() => setZoomSrc(att.data)}
            />
          ) : (
            <div
              key={`${att.name}-${i}`}
              className="flex items-center gap-1 px-2 py-1 text-[11px] rounded-lg border border-[var(--color-border)] bg-[var(--color-sidebar)] text-[var(--color-text-muted)]"
              title={`${att.name} (${formatSize(att.size)})`}
            >
              📄 <span className="truncate max-w-[120px] text-[var(--color-text)]">{att.name}</span>
            </div>
          )
        )}
      </div>
      {zoomSrc && <ImageLightbox src={zoomSrc} onClose={() => setZoomSrc(null)} />}
    </>
  )
}
