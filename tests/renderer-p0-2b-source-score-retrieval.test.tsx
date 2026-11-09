// @vitest-environment jsdom
// P0-2b：来源分数 + 零命中可见
//
// 现场：`MessageBubble` 原先只在 `sources.length > 0` 时渲染来源区，
// 于是「没启用知识库」「检索了但 0 条达标」「检索失败」三种完全不同的事实，
// 在屏上都是"什么都没有"——用户没法知道助手到底查没查。
//
// 本文件钉四件事：
//  ① 三态各自说自己的话（off / empty / failed），命中 >0 时不多嘴；
//  ② 旧消息没有 retrieval 字段 ⇒ 一句状态也不说（不是当成 off）；
//  ③ 分数徽标只在 `score` 是 number 时出现——缺字段不显示 0、更不能显示 NaN；
//  ④ 分数是检索层原样搬来的（取数路径断言放在 kb-ask / agent-context / kb-real-embedding 三份用例里），
//    这里只验证渲染层不造值、且四语 key 齐全。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { MessageBubble } from '../src/renderer/src/modules/chat/MessageBubble'
import { AgentMessageCard } from '../src/renderer/src/components/agent/AgentMessageCard'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'
import type { AgentMessage } from '../src/renderer/src/components/agent/agent-shared'
import type { MessageRetrieval, MessageSource } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!

function src(over: Partial<MessageSource> = {}): MessageSource {
  return { chunkId: 'c1', docId: 'd1', docTitle: '退款手册', content: '7 天内可退款。', kbId: 'kb1', seq: 1, ...over }
}

function mountBubble(over: { retrieval?: MessageRetrieval; sources?: MessageSource[] } = {}) {
  return mountWithProviders(
    <MessageBubble role="assistant" content="答案正文" messageId="a1" {...over} />
  )
}

function mountAgent(over: { retrieval?: MessageRetrieval; sources?: MessageSource[] } = {}) {
  const m: AgentMessage = {
    id: 'a1',
    role: 'assistant',
    text: '根据资料，7 天内可退款。',
    isFinal: true,
    dbId: 'db1',
    ...over
  }
  return mountWithProviders(<AgentMessageCard m={m} />)
}

/** 展开「引用来源」折叠区（分数徽标与口径说明只在这之后出现） */
function expandSources(count: number) {
  fireEvent.click(screen.getByText(L('chatview.sources').replace('{count}', String(count))))
}

beforeEach(() => {
  stubPocketai({})
})

describe('聊天气泡：三种检索事实分开说', () => {
  it('a) 未启用知识库 → 说「本轮未启用」，不说"没找到"', () => {
    mountBubble({ retrieval: { searched: false, hits: 0 } })
    expect(screen.getByText(L('chatview.retrieval.off'))).toBeTruthy()
    expect(screen.queryByText(L('chatview.retrieval.empty'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.failed'))).toBeNull()
  })

  it('b) 启用了、检索过、0 条达标 → 说「没找到相关内容」', () => {
    mountBubble({ retrieval: { searched: true, hits: 0, kbCount: 2 } })
    expect(screen.getByText(L('chatview.retrieval.empty'))).toBeTruthy()
    expect(screen.queryByText(L('chatview.retrieval.off'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.failed'))).toBeNull()
  })

  it('c) 检索过程失败 → 说「检索失败」，不冒充"没找到"', () => {
    mountBubble({ retrieval: { searched: true, hits: 0, failed: true, kbCount: 2 } })
    expect(screen.getByText(L('chatview.retrieval.failed'))).toBeTruthy()
    expect(screen.queryByText(L('chatview.retrieval.empty'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.off'))).toBeNull()
  })

  it('命中 >0 → 三句都不出现（来源列表本身就是事实）', () => {
    mountBubble({ retrieval: { searched: true, hits: 2 }, sources: [src()] })
    expect(screen.queryByText(L('chatview.retrieval.off'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.empty'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.failed'))).toBeNull()
  })

  it('旧消息没有 retrieval 字段 → 一句状态也不说（不能当成"未启用"）', () => {
    mountBubble()
    expect(screen.queryByText(L('chatview.retrieval.off'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.empty'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.failed'))).toBeNull()
  })
})

describe('Agent 消息卡：同一套事实同样可见', () => {
  it('未启用 / 0 命中 / 失败三态各说各的', () => {
    const { unmount } = mountAgent({ retrieval: { searched: false, hits: 0 } })
    expect(screen.getByText(L('chatview.retrieval.off'))).toBeTruthy()
    unmount()

    mountAgent({ retrieval: { searched: true, hits: 0, kbCount: 1 } })
    expect(screen.getByText(L('chatview.retrieval.empty'))).toBeTruthy()
  })

  it('失败态优先于"0 命中"（失败不是"没找到"）', () => {
    mountAgent({ retrieval: { searched: true, hits: 0, failed: true, kbCount: 1 } })
    expect(screen.getByText(L('chatview.retrieval.failed'))).toBeTruthy()
    expect(screen.queryByText(L('chatview.retrieval.empty'))).toBeNull()
  })

  it('旧消息无字段 → 不渲染状态句', () => {
    mountAgent()
    expect(screen.queryByText(L('chatview.retrieval.off'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.empty'))).toBeNull()
    expect(screen.queryByText(L('chatview.retrieval.failed'))).toBeNull()
  })
})

describe('来源分数徽标：只显示真分，缺字段不补 0', () => {
  it('带 score ⇒ 显示三位小数，并给出"同轮内可比、跨轮不可比"的口径说明', () => {
    mountBubble({ sources: [src({ score: 0.0342 })] })
    expandSources(1)
    expect(screen.getByText(L('chatview.sourceScore').replace('{score}', '0.034'))).toBeTruthy()
    expect(screen.getByText(L('chatview.sourceScoreNote'))).toBeTruthy()
  })

  it('旧来源没有 score ⇒ 不显示徽标、不显示 0 分、不显示 NaN、也不摆口径说明', () => {
    mountBubble({ sources: [src()] })
    expandSources(1)
    expect(screen.queryByText(/融合分/)).toBeNull()
    expect(screen.queryByText(/NaN/)).toBeNull()
    expect(screen.queryByText(L('chatview.sourceScoreNote'))).toBeNull()
  })

  it('混合新旧来源 ⇒ 只有带真分的那条有徽标（数量对得上）', () => {
    mountBubble({ sources: [src({ chunkId: 'c1', score: 0.02 }), src({ chunkId: 'c2' })] })
    expandSources(2)
    // 只数徽标本身（口径说明里也含"融合分"三个字，不能用宽匹配）
    expect(
      screen.getAllByText(L('chatview.sourceScore').replace('{score}', '0.020'))
    ).toHaveLength(1)
    expect(screen.getByText(L('chatview.sourceScoreNote'))).toBeTruthy()
  })

  it('Agent 卡片同样：缺 score 不显示 0 分/NaN', () => {
    mountAgent({ sources: [src()] })
    expandSources(1)
    expect(screen.queryByText(/融合分/)).toBeNull()
    expect(screen.queryByText(/NaN/)).toBeNull()
  })
})

describe('四语 key parity（本次新增的 5 个 key）', () => {
  const KEYS = [
    'chatview.sourceScore',
    'chatview.sourceScoreNote',
    'chatview.retrieval.off',
    'chatview.retrieval.empty',
    'chatview.retrieval.failed'
  ] as const
  const dicts: Record<string, Record<string, string>> = { zh, en, ja, ko }

  it('四本字典都有这 5 个 key，且非空', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      for (const k of KEYS) {
        expect(dict[k], `${name}.${k}`).toBeTruthy()
        expect(dict[k]!.trim().length, `${name}.${k}`).toBeGreaterThan(0)
      }
    }
  })

  it('只有 sourceScore 带 {score} 占位符（其余三句不给插值）', () => {
    for (const [name, dict] of Object.entries(dicts)) {
      expect(dict['chatview.sourceScore']!, name).toContain('{score}')
      for (const k of KEYS.slice(1)) {
        expect(dict[k]!, `${name}.${k}`).not.toContain('{')
      }
    }
  })
})
