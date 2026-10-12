// 每条回答后面的「X tokens · 累计 Y」（V4-Iter-111）
//
// 来源：用户反馈——会话累计原来挂在消息流最上方一行独立 chip，往上翻才看得到，
// "放到每个答案的后面"更顺手。这里钉的是显示规则，不是排版：
// ① 累计只在"到本条为止"严格大于本条自身时出现（首条回答累计=本条，说了等于没说）；
// ② 流式中/无 usage 的气泡整行不出现；
// ③ user 气泡永不显示。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import React from 'react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { MessageBubble } from '../src/renderer/src/modules/chat/MessageBubble'
import { zh } from '../src/renderer/src/i18n/zh'
import type { UsageStats } from '../src/shared/types'

const usage = (prompt: number, completion: number): UsageStats => ({
  promptTokens: prompt,
  completionTokens: completion,
  totalTokens: prompt + completion
})

function mount(props: Partial<React.ComponentProps<typeof MessageBubble>> = {}) {
  return mountWithProviders(
    <MessageBubble
      role="assistant"
      content="答案正文"
      messageId="a1"
      streaming={false}
      usage={usage(1000, 200)}
      {...props}
    />
  )
}

beforeEach(() => {
  stubPocketai({
    speakText: () => undefined,
    stopSpeak: () => undefined,
    copyToClipboard: () => undefined
  })
})

/** 本条用量 1.2k：累计文案是否出现 */
describe('每条回答后的累计用量', () => {
  it('累计大于本条 → 同一行里带上「累计 …」', () => {
    mount({ sessionTokensUpTo: 4800 })
    const line = screen.getByText(/tokens/)
    expect(line.textContent).toContain('1.2k')
    expect(line.textContent).toContain('累计')
    expect(line.textContent).toContain('4.8k')
  })

  it('首条回答（累计=本条）→ 只显示本条，不重复一遍累计', () => {
    mount({ sessionTokensUpTo: 1200 })
    const line = screen.getByText(/tokens/)
    expect(line.textContent).toContain('1.2k')
    expect(line.textContent).not.toContain('累计')
  })

  it('不传累计（老会话/未加载）→ 一切照旧，不出现空占位', () => {
    mount({ sessionTokensUpTo: null })
    const line = screen.getByText(/tokens/)
    expect(line.textContent).toBe(zh['chatview.tokenLine'].replace('{tokens}', '1.2k'))
  })

  it('流式中不显示用量行（本条还没结束，累计也不该提前跳）', () => {
    mount({ streaming: true, sessionTokensUpTo: 4800 })
    expect(screen.queryByText(/tokens/)).toBeNull()
  })

  it('user 气泡永不显示用量行', () => {
    mount({ role: 'user', sessionTokensUpTo: 4800 })
    expect(screen.queryByText(/tokens/)).toBeNull()
  })
})
