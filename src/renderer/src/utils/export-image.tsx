// 会话导出为 PNG 长图
//
// 思路：把完整 messages 临时渲染到 document.body 下的离屏容器（绕过消息流虚拟化，
// 保证 DOM 完整），用 html-to-image 截图 → dataURL → Blob → a[download] 触发下载。
// 离屏容器 position:fixed left:-9999px，宽度与正常消息流一致（max-w-5xl），
// 高度由内容撑开；完成即卸载。
//
// 故意不在此复用 MessageBubble（其含 hover 操作按钮/引用条等交互元素，截图价值低且增复杂度），
// 只渲染：助手名头部、每条消息的角色气泡 + Markdown 正文 + 附件名列表。
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { toPng } from 'html-to-image'
import type { MessageRecord } from '../../../shared/types'
import { Markdown } from '../modules/chat/Markdown'
import { formatDateTime } from './time'

export interface ExportImageOptions {
  messages: MessageRecord[]
  truncated: boolean
  assistantName: string | null
  fileName: string
  t: (k: string, p?: Record<string, string | number>) => string
}

function getCssVar(name: string, fallback: string): string {
  if (typeof getComputedStyle === 'undefined') return fallback
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

/** 单条消息气泡（导出专用，无交互） */
const ExportMessage: React.FC<{ msg: MessageRecord }> = ({ msg }) => {
  const isUser = msg.role === 'user'
  const bg = isUser
    ? getCssVar('--color-accent-soft', '#eef2ff')
    : getCssVar('--color-sidebar', '#f5f5f5')
  const fg = isUser ? getCssVar('--color-text', '#111') : getCssVar('--color-text', '#111')
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start', marginBottom: 12 }}>
      <div
        style={{
          maxWidth: '78%',
          padding: '8px 12px',
          borderRadius: 12,
          background: bg,
          color: fg,
          fontSize: 14,
          lineHeight: 1.6,
          wordBreak: 'break-word'
        }}
      >
        <div style={{ fontSize: 11, opacity: 0.55, marginBottom: 4 }}>
          {isUser ? 'You' : (msg.model ?? 'Assistant')} · {formatDateTime(msg.createdAt)}
        </div>
        <Markdown content={msg.content} codeCopy={false} />
        {msg.attachments && msg.attachments.length > 0 && (
          <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
            {msg.attachments.map((a, i) => (
              <div key={i}>📎 {a.name}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

const ExportCanvas: React.FC<{ options: ExportImageOptions }> = ({ options }) => {
  const { messages, truncated, assistantName, t } = options
  const bg = getCssVar('--color-bg', '#ffffff')
  const fg = getCssVar('--color-text', '#111')
  const muted = getCssVar('--color-text-muted', '#888')
  return (
    <div
      data-export-canvas
      style={{
        position: 'fixed',
        left: -9999,
        top: 0,
        width: 800,
        padding: 24,
        background: bg,
        color: fg,
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}
    >
      <div style={{ marginBottom: 16, paddingBottom: 12, borderBottom: `1px solid ${muted}` }}>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{assistantName || 'PocketAI'}</div>
        <div style={{ fontSize: 12, color: muted, marginTop: 2 }}>
          {formatDateTime(Date.now())}
          {truncated && ` · ${t('chat.exportImageTooLong')}`}
        </div>
      </div>
      {messages.map((m) => (
        <ExportMessage key={m.id} msg={m} />
      ))}
    </div>
  )
}

/** 等待下一帧渲染完成 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()))
}

export async function exportConversationAsPng(options: ExportImageOptions): Promise<string> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = null
  try {
    root = createRoot(container)
    root.render(<ExportCanvas options={options} />)
    // 等两帧：一帧挂载、一帧 Markdown 子树渲染
    await nextFrame()
    await nextFrame()
    const el = container.querySelector('[data-export-canvas]') as HTMLElement | null
    if (!el) throw new Error('export canvas not found')
    const dataUrl = await toPng(el, {
      pixelRatio: 2,
      backgroundColor: getCssVar('--color-bg', '#ffffff'),
      cacheBust: true
    })
    const blob = await (await fetch(dataUrl)).blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = options.fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return dataUrl // 返回给调用方缓存（导出拖拽复用，免重复截图）
  } finally {
    if (root) {
      root.unmount()
      setTimeout(() => container.remove(), 0)
    } else {
      container.remove()
    }
  }
}
