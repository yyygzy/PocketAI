// 每条回答后面的「X tokens · 累计 Y」（V4-Iter-111）
//
// 来源：用户反馈——会话累计原来挂在消息流最上方一行独立 chip，往上翻才看得到，
// "放到每个答案的后面"更顺手。这里钉的是显示规则，不是排版：
// ① 累计只在"到本条为止"严格大于本条自身时出现（首条回答累计=本条，说了等于没说）；
// ② 流式中/无 usage 的气泡整行不出现；
// ③ user 气泡永不显示。
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { screen, fireEvent } from '@testing-library/react'
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
// —— V4-Iter-172：B52 对账现查的两条零覆盖 ——
// ① 那行字**点下去要弹用量详情**（此前只测了显示规则，没人点过）；
// ② 配了本机单价时**费用要出现在气泡里**（该文件此前 `¥` 0 命中）。
describe('点那行弹详情 + 费用出现在气泡（V4-Iter-172 补）', () => {
  // 单价按「每 100 万 token」计：1000 输入 ×2000 + 200 输出 ×8000 ⇒ 3.60 元
  const PRICING = { currency: 'CNY' as const, prices: { 'deepseek::deepseek-chat': { input: 2000, output: 8000 } } }

  it('给了 provider/model/pricing ⇒ 同一行里出现 ¥3.60', () => {
    mount({ provider: 'deepseek', model: 'deepseek-chat', pricing: PRICING })
    expect(screen.getByText(/¥3\.60/)).toBeTruthy()
  })

  it('反向对照：没有 pricing 时不出现任何货币符号（只显示 token 数）', () => {
    mount()
    const line = screen.getByText(/tokens/)
    expect(line.textContent).not.toContain('¥')
    expect(line.textContent).not.toContain('$')
  })

  it('点那行 ⇒ 用量详情浮层出现，里面是分项（输入/输出/单价）而不是一句话', async () => {
    mount({ provider: 'deepseek', model: 'deepseek-chat', pricing: PRICING })
    fireEvent.click(screen.getByText(/tokens/))
    expect(await screen.findByText(zh['chat.usageDetail'])).toBeTruthy()
    expect(screen.getByText(zh['usage.priceInput'])).toBeTruthy()
    expect(screen.getByText(zh['usage.priceOutput'])).toBeTruthy()
  })

  it('悬停那行的 title 明说"点击查看用量详情"（可点这件事要有线索）', () => {
    mount()
    expect(screen.getByText(/tokens/).getAttribute('title')).toContain(zh['chat.usageDetailHint'])
  })
})
