// context-attachments 聊天上下文附件收口层测试
//
// 覆盖 src/main/chat/context-attachments.ts 三个纯函数：
// - appendTextAttachments：文本附件拼接为「--- name ---」分隔区块
// - buildImageParts：text 在前 + image_url parts
// - injectAttachments：注入最后一条 user 消息（字符串/parts 内容、混合附件、无 user 不动）
import { describe, it, expect } from 'vitest'
import {
  appendTextAttachments,
  buildImageParts,
  injectAttachments
} from '../src/main/chat/context-attachments'
import type { ChatAttachment } from '../src/shared/types'

function att(type: 'text' | 'image', name: string, data: string): ChatAttachment {
  return { type, name, mimeType: type === 'image' ? 'image/png' : 'text/plain', size: 1, data }
}

// ---------- appendTextAttachments ----------

describe('appendTextAttachments 文本附件拼接', () => {
  it('空数组：原文返回', () => {
    expect(appendTextAttachments('你好', [])).toBe('你好')
  })

  it('单个附件：追加「--- name ---」区块', () => {
    expect(appendTextAttachments('你好', [att('text', 'a.txt', '内容A')]))
      .toBe('你好\n\n--- a.txt ---\n内容A')
  })

  it('多个附件：按顺序各占一个区块', () => {
    const out = appendTextAttachments('问', [
      att('text', 'a.txt', '内容A'),
      att('text', 'b.md', '内容B')
    ])
    expect(out).toBe('问\n\n--- a.txt ---\n内容A\n\n--- b.md ---\n内容B')
  })

  it('原文为空串：仅附件区块', () => {
    expect(appendTextAttachments('', [att('text', 'n.txt', 'X')]))
      .toBe('\n\n--- n.txt ---\nX')
  })
})

// ---------- buildImageParts ----------

describe('buildImageParts 多模态 parts 构建', () => {
  it('无图片：仅 text part', () => {
    expect(buildImageParts('看', [])).toEqual([{ type: 'text', text: '看' }])
  })

  it('多张图片：text 在前 + image_url 按顺序', () => {
    const parts = buildImageParts('看', [att('image', 'p1', 'data:1'), att('image', 'p2', 'data:2')])
    expect(parts).toEqual([
      { type: 'text', text: '看' },
      { type: 'image_url', image_url: { url: 'data:1' } },
      { type: 'image_url', image_url: { url: 'data:2' } }
    ])
  })
})

// ---------- injectAttachments ----------

describe('injectAttachments 注入最后一条 user 消息', () => {
  it('无附件 / 空数组：消息原样不动', () => {
    const msgs = [{ role: 'user' as const, content: '原话' }]
    injectAttachments(msgs, undefined)
    injectAttachments(msgs, [])
    expect(msgs[0]!.content).toBe('原话')
  })

  it('最后一条 user 为字符串内容：仅文本附件时 content 仍为字符串', () => {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: '原话' }
    ]
    injectAttachments(msgs, [att('text', 'a.txt', '内容A')])
    expect(msgs[1]!.content).toBe('原话\n\n--- a.txt ---\n内容A')
  })

  it('user 内容为 parts 数组：兜底分支按空文本处理，仅附件区块（固化现状语义）', () => {
    const msgs = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '原话' }] }]
    injectAttachments(msgs, [att('text', 'a.txt', 'X')])
    expect(msgs[0]!.content).toBe('\n\n--- a.txt ---\nX')
  })

  it('文本 + 图片混合：content 重建为 parts（text 含附件区块 + image_url）', () => {
    const msgs = [{ role: 'user' as const, content: '看这个' }]
    injectAttachments(msgs, [att('text', 'a.txt', 'X'), att('image', 'p1', 'data:1')])
    expect(msgs[0]!.content).toEqual([
      { type: 'text', text: '看这个\n\n--- a.txt ---\nX' },
      { type: 'image_url', image_url: { url: 'data:1' } }
    ])
  })

  it('user 之前有 assistant 消息：注入的是最后一条 user 而非末尾消息', () => {
    const msgs = [
      { role: 'user' as const, content: '第一问' },
      { role: 'assistant' as const, content: '答' }
    ]
    injectAttachments(msgs, [att('text', 'a.txt', 'X')])
    expect(msgs[0]!.content).toBe('第一问\n\n--- a.txt ---\nX')
    expect(msgs[1]!.content).toBe('答')
  })

  it('无 user 消息：整个数组不动', () => {
    const msgs = [
      { role: 'system' as const, content: 'sys' },
      { role: 'assistant' as const, content: 'hi' }
    ]
    injectAttachments(msgs, [att('text', 'a.txt', 'X')])
    expect(msgs).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: 'hi' }
    ])
  })
})
