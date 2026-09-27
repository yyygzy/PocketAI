// AttachmentGrid / ImageLightbox 渲染测试（node 环境 + react-dom/server）
//
// 回归点：缩略图必须渲染（曾点击走 window.open(data:) 被安全策略静默拒绝，
// 现改为应用内 lightbox）；ImageLightbox 放大态必须渲染原图。
import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'
import { AttachmentGrid, ImageLightbox } from '../src/renderer/src/components/AttachmentGrid'
import type { ChatAttachment } from '../src/shared/types'

const PNG_DATA =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC'

function imageAtt(name = 'a.png'): ChatAttachment {
  return { name, type: 'image', mimeType: 'image/png', size: 100, data: PNG_DATA }
}
function fileAtt(name = 'note.txt'): ChatAttachment {
  return { name, type: 'text', mimeType: 'text/plain', size: 200, data: '' }
}

describe('AttachmentGrid — 静态渲染', () => {
  it('空附件 → null（无输出）', () => {
    expect(renderToString(React.createElement(AttachmentGrid, { attachments: [] }))).toBe('')
  })

  it('图片附件：缩略图渲染 data URL 与 alt，光标为 zoom-in', () => {
    const html = renderToString(
      React.createElement(AttachmentGrid, { attachments: [imageAtt('照片.png')] })
    )
    expect(html).toContain('<img')
    expect(html).toContain('src="data:image/')
    expect(html).toContain('alt="照片.png"')
    expect(html).toContain('cursor-zoom-in')
    // 默认状态 lightbox 关闭：无 dialog
    expect(html).not.toContain('role="dialog"')
  })

  it('文件附件：渲染文件名卡片', () => {
    const html = renderToString(
      React.createElement(AttachmentGrid, { attachments: [fileAtt('说明.txt')] })
    )
    expect(html).toContain('说明.txt')
    expect(html).not.toContain('<img')
  })

  it('图片+文件混合，各自渲染', () => {
    const html = renderToString(
      React.createElement(AttachmentGrid, { attachments: [imageAtt(), fileAtt()] })
    )
    expect(html).toContain('<img')
    expect(html).toContain('note.txt')
  })
})

describe('ImageLightbox — 放大态渲染', () => {
  it('渲染原图 + dialog 语义 + 遮罩', () => {
    const html = renderToString(
      React.createElement(ImageLightbox, { src: PNG_DATA, onClose: () => {} })
    )
    expect(html).toContain('role="dialog"')
    expect(html).toContain('aria-modal="true"')
    expect(html).toContain('fixed inset-0')
    expect(html).toContain('src="data:image/')
    expect(html).toContain('max-h-full')
  })
})
