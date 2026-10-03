// 会话内搜索纯函数 findMatchIds 测试
import { describe, it, expect } from 'vitest'
import { findMatchIds } from '../src/renderer/src/modules/chat/ChatView'
import type { MessageRecord } from '../src/shared/types'

const mk = (id: string, content: string, attachments?: { type: 'image'; name: string; mimeType: string; size: number; data: string }[]): MessageRecord => ({
  id,
  conversationId: 'c1',
  role: 'user',
  content,
  provider: null,
  model: null,
  status: 'done',
  parentId: null,
  createdAt: 0,
  attachments
})

describe('findMatchIds 会话内消息搜索', () => {
  const messages = [
    mk('m1', '你好，帮我写一个排序算法'),
    mk('m2', '这是冒泡排序的实现'),
    mk('m3', '有没有更快的排序？'),
    mk('m4', '快速排序平均 O(n log n)'),
    mk('m5', '谢谢！')
  ]

  it('关键词为空返回空数组', () => {
    expect(findMatchIds(messages, '')).toEqual([])
    expect(findMatchIds(messages, '   ')).toEqual([])
  })

  it('不区分大小写匹配', () => {
    expect(findMatchIds(messages, 'O(n')).toEqual(['m4'])
    expect(findMatchIds(messages, 'o(n log n)')).toEqual(['m4'])
  })

  it('多命中按消息顺序返回全部 id', () => {
    expect(findMatchIds(messages, '排序')).toEqual(['m1', 'm2', 'm3', 'm4'])
  })

  it('无命中返回空数组', () => {
    expect(findMatchIds(messages, '不存在的关键词')).toEqual([])
  })

  it('自动 trim 关键词首尾空白', () => {
    expect(findMatchIds(messages, '  冒泡  ')).toEqual(['m2'])
  })

  it('跳过空 content 的消息', () => {
    const withEmpty = [...messages, mk('m6', '')]
    expect(findMatchIds(withEmpty, '')).toEqual([])
    // 空 content 不会被任意关键词命中
    expect(findMatchIds(withEmpty, '排序')).not.toContain('m6')
  })

  it('附件文件名参与匹配（不区分大小写）', () => {
    const withAtt = [
      mk('a1', '看一下这张图', [
        { type: 'image', name: 'Screenshot-2026.png', mimeType: 'image/png', size: 100, data: 'data:image/png;base64,xx' }
      ]),
      mk('a2', '', [
        { type: 'image', name: '报错截图.PNG', mimeType: 'image/png', size: 100, data: 'data:image/png;base64,yy' }
      ])
    ]
    expect(findMatchIds(withAtt, 'screenshot')).toEqual(['a1'])
    expect(findMatchIds(withAtt, '截图')).toEqual(['a2'])
    // content 命中优先，附件命中不重复
    expect(findMatchIds([...messages, ...withAtt], '排序')).toEqual(['m1', 'm2', 'm3', 'm4'])
  })
})
