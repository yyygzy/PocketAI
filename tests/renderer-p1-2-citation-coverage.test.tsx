// @vitest-environment jsdom
// P1-2：回答侧「引用覆盖率」。
//
// 口径（拍板后写死在这里，改口径必须改本用例）：
//  - 分母＝本轮检索达标条数（retrieval.hits）；旧消息无 retrieval 时才回退到已列来源数；
//  - 正文没有任何引用 ⇒ 显示 0%，不是隐藏；
//  - 没有来源 ⇒ 整行不出现；
//  - 代码块/行内代码/链接里的方括号不算引用（与 remark 插件的 text 节点口径一致）；
//  - 混入网页来源时两边不是同一口径，整行不出现，不造比例。
import { describe, it, expect, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { MessageBubble } from '../src/renderer/src/modules/chat/MessageBubble'
import { collectCitationRefs } from '../src/renderer/src/modules/chat/remark-citations'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { MessageRetrieval, MessageSource } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

function src(over: Partial<MessageSource> = {}): MessageSource {
  return {
    chunkId: 'c1',
    docId: 'd1',
    docTitle: '退款手册',
    content: '7 天内可退款。',
    kbId: 'kb1',
    seq: 1,
    ...over
  }
}

function coverageText(percent: number, cited: number, total: number): string {
  return L('chatview.citationCoverage')
    .replace('{percent}', String(percent))
    .replace('{cited}', String(cited))
    .replace('{total}', String(total))
}

function mountBubble(over: {
  content?: string
  retrieval?: MessageRetrieval
  sources?: MessageSource[]
} = {}) {
  return mountWithProviders(
    <MessageBubble role="assistant" content="答案正文" messageId="a1" {...over} />
  )
}

beforeEach(() => {
  stubPocketai({})
})

describe('P1-2 引用覆盖率', () => {
  it('正文引用 1/2 条 ⇒ 50%，分母取 retrieval.hits', () => {
    mountBubble({
      content: '结论见 [1]。',
      retrieval: { searched: true, hits: 2, kbCount: 1 },
      sources: [src(), src({ chunkId: 'c2', docTitle: '售后手册' })]
    })
    expect(screen.getByText(coverageText(50, 1, 2))).toBeTruthy()
  })

  it('正文没有任何引用 ⇒ 显示 0%，不隐藏该行', () => {
    mountBubble({
      content: '这是一段没有编号引用的回答。',
      retrieval: { searched: true, hits: 2, kbCount: 1 },
      sources: [src(), src({ chunkId: 'c2' })]
    })
    expect(screen.getByText(coverageText(0, 0, 2))).toBeTruthy()
  })

  it('没有来源 ⇒ 不显示该行', () => {
    mountBubble({
      content: '结论见 [1]。',
      retrieval: { searched: true, hits: 0 },
      sources: []
    })
    expect(screen.queryByText(coverageText(0, 0, 0))).toBeNull()
    expect(screen.queryByText(/引用覆盖率/)).toBeNull()
  })

  it('检索失败 ⇒ 不算覆盖率（不拿 0 条当分母）', () => {
    mountBubble({
      content: '结论见 [1]。',
      retrieval: { searched: true, hits: 2, failed: true },
      sources: [src(), src({ chunkId: 'c2' })]
    })
    expect(screen.queryByText(/引用覆盖率/)).toBeNull()
  })

  it('混入网页来源 ⇒ 口径不同，不显示比例', () => {
    mountBubble({
      content: '结论见 [1]。',
      retrieval: { searched: true, hits: 2 },
      sources: [src(), src({ chunkId: 'w1', kind: 'web', url: 'https://example.com/a' })]
    })
    expect(screen.queryByText(/引用覆盖率/)).toBeNull()
  })

  it('口径说明挂在同一行 title 上，四语键齐全', () => {
    for (const dict of [zh, en, ja, ko]) {
      const d = dict as unknown as Record<string, string>
      expect(d['chatview.citationCoverage']).toBeTruthy()
      expect(d['chatview.citationCoverageNote']).toBeTruthy()
      expect(d['chatview.citationCoverage']).toContain('{percent}')
      expect(d['chatview.citationCoverage']).toContain('{cited}')
      expect(d['chatview.citationCoverage']).toContain('{total}')
    }
  })
})

describe('P1-2 引用编号收集：与渲染口径一致', () => {
  it('去重升序，且跳过代码块／行内代码／链接', () => {
    const md = [
      '正文 [2] 与 [1]，重复 [1]。',
      '`[9]` 行内代码不算，',
      '```ts',
      'const a = [7]',
      '```',
      '[3](https://example.com) 链接文字不算方括号引用，',
      '图片 ![4](https://example.com/x.png) 也不算。'
    ].join('\n')
    expect(collectCitationRefs(md)).toEqual([1, 2])
  })

  it('两位数以内的编号才收（[1000] 不是引用）', () => {
    expect(collectCitationRefs('数组下标 [1000]，引用 [3]。')).toEqual([3])
  })
})
