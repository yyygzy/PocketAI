// 智能标题接入结构化契约层的接线测试：
// 成功升级 / 纯文本回退 / 坏 JSON 不污染标题 / 修复一次 / 修复轮抛错 / 首轮抛错 / 开关关闭
import { describe, it, expect, vi, beforeEach } from 'vitest'

const H = vi.hoisted(() => ({
  responses: [] as Array<string | Error>,
  calls: 0,
  renamed: [] as Array<{ id: string; title: string }>,
  broadcasts: [] as Array<{ channel: string; payload: unknown }>,
  smartTitle: true
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('../src/main/providers/manager', () => ({
  providerManager: {
    getAdapter: () => ({
      streamChat: async () => {
        const index = H.calls
        H.calls += 1
        const next = H.responses[index] ?? H.responses[H.responses.length - 1]
        if (next instanceof Error) throw next
        return { content: next ?? '' }
      }
    })
  }
}))

vi.mock('../src/main/db/repositories/conversation.repo', () => ({
  conversationRepo: {
    get: () => ({ titleDefault: true, title: '新对话' }),
    setTitleDefault: () => {},
    rename: (id: string, title: string) => {
      H.renamed.push({ id, title })
    }
  }
}))

vi.mock('../src/main/ipc/broadcast', () => ({
  broadcast: (channel: string, payload: unknown) => {
    H.broadcasts.push({ channel, payload })
  }
}))

vi.mock('../src/main/conversation/title-config', () => ({
  isSmartTitleEnabled: () => H.smartTitle
}))

vi.mock('../src/main/providers/local-slot', () => ({
  runInSlotKind: (_kind: string, fn: () => Promise<unknown>) => fn()
}))

import { IPC } from '../src/shared/types'
import { runFirstMessageTitle } from '../src/main/conversation/title-gen'

const USER_CONTENT = '帮我翻译这份英文合同里的关键条款和风险提示'
const FALLBACK = USER_CONTENT.slice(0, 20)

function run(): void {
  runFirstMessageTitle({
    conversationId: 'c1',
    userContent: USER_CONTENT,
    providerId: 'p1',
    model: 'm1'
  })
}

async function waitCalls(n: number): Promise<void> {
  await vi.waitFor(() => expect(H.calls).toBe(n))
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  H.responses = []
  H.calls = 0
  H.renamed = []
  H.broadcasts = []
  H.smartTitle = true
})

describe('title-gen 结构化契约接线', () => {
  it('合法 JSON ⇒ 升级标题并广播，只调用一次模型', async () => {
    H.responses = ['{"title":"合同条款翻译"}']
    run()

    expect(H.renamed[0]).toEqual({ id: 'c1', title: FALLBACK })
    await vi.waitFor(() => expect(H.renamed.length).toBe(2))

    expect(H.renamed[1]).toEqual({ id: 'c1', title: '合同条款翻译' })
    expect(H.calls).toBe(1)
    expect(H.broadcasts).toHaveLength(1)
    expect(H.broadcasts[0]?.channel).toBe(IPC.CONVERSATION_TITLE_EVENT)
    expect(H.broadcasts[0]?.payload).toEqual({ conversationId: 'c1', title: '合同条款翻译' })
  })

  it('多余字段被忽略（标题只消费 title），不触发修复', async () => {
    H.responses = ['{"title":"合同条款翻译","reason":"模型多说了两句"}']
    run()

    await vi.waitFor(() => expect(H.renamed.length).toBe(2))
    expect(H.renamed[1]?.title).toBe('合同条款翻译')
    expect(H.calls).toBe(1)
  })

  it('首轮纯文本、修复轮 JSON ⇒ 用修复结果', async () => {
    H.responses = ['合同条款翻译', '{"title":"合同翻译"}']
    run()

    await vi.waitFor(() => expect(H.renamed.length).toBe(2))
    expect(H.renamed[1]?.title).toBe('合同翻译')
    expect(H.calls).toBe(2)
  })

  it('两轮都是纯文本 ⇒ 回退清洗原文，保留旧的容错降级', async () => {
    H.responses = ['合同条款翻译', '合同条款翻译']
    run()

    await vi.waitFor(() => expect(H.renamed.length).toBe(2))
    expect(H.renamed[1]?.title).toBe('合同条款翻译')
    expect(H.calls).toBe(2)
  })

  it('JSON 能解析但 title 非法 ⇒ 不把坏 JSON 当标题，保留截断标题', async () => {
    H.responses = ['{"title":123}', '{"title":123}']
    run()

    await waitCalls(2)
    expect(H.renamed).toEqual([{ id: 'c1', title: FALLBACK }])
    expect(H.broadcasts).toHaveLength(0)
  })

  it('修复轮抛错 ⇒ 保留首轮可清洗文本', async () => {
    H.responses = ['合同条款翻译', new Error('timeout')]
    run()

    await waitCalls(2)
    expect(H.renamed).toHaveLength(2)
    expect(H.renamed[1]?.title).toBe('合同条款翻译')
  })

  it('首轮抛错 ⇒ 静默保留截断标题，不阻断对话', async () => {
    H.responses = [new Error('boom')]
    run()

    await waitCalls(1)
    expect(H.renamed).toEqual([{ id: 'c1', title: FALLBACK }])
    expect(H.broadcasts).toHaveLength(0)
  })

  it('智能标题开关关闭 ⇒ 不调用模型', () => {
    H.smartTitle = false
    run()

    expect(H.calls).toBe(0)
    expect(H.renamed).toEqual([{ id: 'c1', title: FALLBACK }])
  })
})
