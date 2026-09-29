// KB 问答消息拼装纯函数测试（不触 electron，ask-service 顶层 import 链路含 electron
// 的 ragService/providerManager，但 buildAskMessages 是纯函数——vi.mock 掉重依赖）
import { describe, it, expect, vi } from 'vitest'

vi.mock('../src/main/knowledge/rag', () => ({ ragService: {} }))
vi.mock('../src/main/providers/manager', () => ({ providerManager: {} }))

import {
  buildAskMessages,
  chunksToSources,
  KB_ASK_MAX_HISTORY
} from '../src/main/knowledge/ask-service'

describe('buildAskMessages — 问答消息拼装', () => {
  it('无历史：system(上下文) + user(问题)', () => {
    const msgs = buildAskMessages('问题', '【知识库】上下文', [])
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ role: 'system', content: '【知识库】上下文' })
    expect(msgs[1]).toEqual({ role: 'user', content: '问题' })
  })

  it('有历史：按原顺序插入 system 与最终 user 之间', () => {
    const history = [
      { role: 'user' as const, content: 'q1' },
      { role: 'assistant' as const, content: 'a1' }
    ]
    const msgs = buildAskMessages('q2', 'ctx', history)
    expect(msgs).toHaveLength(4)
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user'])
    expect(msgs[3]!.content).toBe('q2')
  })

  it(`历史超过 ${KB_ASK_MAX_HISTORY} 条时截断保留最近的`, () => {
    const history = Array.from({ length: KB_ASK_MAX_HISTORY + 5 }, (_, i) => ({
      role: 'user' as const,
      content: `q${i}`
    }))
    const msgs = buildAskMessages('new', 'ctx', history)
    // system + 10 条历史 + user
    expect(msgs).toHaveLength(KB_ASK_MAX_HISTORY + 2)
    expect(msgs[1]!.content).toBe(`q5`)
    expect(msgs[KB_ASK_MAX_HISTORY]!.content).toBe('q14')
  })

  it('空内容的历史消息被过滤，空上下文则无 system', () => {
    const history = [
      { role: 'user' as const, content: '  ' },
      { role: 'assistant' as const, content: 'ok' }
    ]
    const msgs = buildAskMessages('q', '', history)
    expect(msgs.map((m) => m.role)).toEqual(['assistant', 'user'])
  })

  it('chunksToSources：RetrievedChunk 映射为 MessageSource', () => {
    const out = chunksToSources([
      { chunkId: 'c1', docId: 'd1', docTitle: '手册', content: '正文', score: 0.9 }
    ])
    expect(out).toEqual([{ chunkId: 'c1', docId: 'd1', docTitle: '手册', content: '正文' }])
  })
})
