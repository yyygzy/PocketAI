// 消息附件网格：图片缩略图（点击新窗口放大）+ 文本类文件卡片
// Chat 与 Agent 历史消息共用，保证渲染一致；发送框内的待发缩略图由各自 Composer 处理
import React from 'react'
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

export const AttachmentGrid: React.FC<Props> = ({ attachments, align = 'end' }) => {
  if (attachments.length === 0) return null
  return (
    <div className={`flex flex-wrap gap-1.5 mt-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {attachments.map((att, i) =>
        att.type === 'image' ? (
          <img
            key={`${att.name}-${i}`}
            src={att.data}
            alt={att.name}
            title={att.name}
            className="w-20 h-20 object-cover rounded-lg border border-[var(--color-border)] cursor-pointer"
            onClick={() => window.open(att.data, '_blank')}
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
  )
}
