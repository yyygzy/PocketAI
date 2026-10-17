// Agent 消息卡的「引用来源 → 跳转原文」入口（V4-Iter-124，知识库 A2 的界面半边）
// @vitest-environment jsdom
//
// 为什么要真挂载而不是只看 source-jump 的纯函数（那份已有 tests/source-jump.test.ts）：
// A2 补的是**数据**，跳转入口在 Agent 卡片上压根不存在（聊天气泡才有）。
// 这个入口的两个风险点都只有挂载才能验到：
//  ① 渲染条件是 `kbId && seq !== undefined`——写成真值判断就会把 seq=0 的那条吃掉；
//  ② 点下去要**同时**满足 source-jump 的三步（写 pending → 请求切模块 → 广播事件），
//     少广播一步就会在知识库模块未挂载时跳空。
// 以及一条反向对照：A2 之前落库的老数据没有这两个字段，那时**不该**出现一个点了没反应的按钮。
import { describe, it, expect, beforeEach } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { AgentMessageCard } from '../src/renderer/src/modules/agent/components/AgentMessageCard'
import { zh } from '../src/renderer/src/i18n/zh'
import type { AgentMessage } from '../src/renderer/src/modules/agent/agent-shared'
import type { MessageSource } from '../src/shared/types'

/** 跳转是跨模块事件广播，这里当真实监听方把两次广播按顺序记下来 */
const seen: Array<{ type: string; detail?: unknown }> = []
window.addEventListener('pocketai:switch-module', (e) =>
  seen.push({ type: e.type, detail: (e as CustomEvent).detail })
)
window.addEventListener('kb-open-source', (e) => seen.push({ type: e.type }))

function src(over: Partial<MessageSource> = {}): MessageSource {
  return {
    chunkId: 'c1',
    docId: 'd1',
    docTitle: '退款手册',
    content: '7 天内可退款，生鲜类除外。',
    kbId: 'kb1',
    seq: 3,
    ...over
  }
}

/** 挂载一条带引用来源的助手消息，并展开「引用来源」折叠区 */
function mountSources(sources: MessageSource[]) {
  const m: AgentMessage = {
    id: 'a1',
    role: 'assistant',
    text: '根据资料，7 天内可退款 [1]。',
    sources,
    isFinal: true,
    dbId: 'db1'
  }
  mountWithProviders(<AgentMessageCard m={m} />)
  fireEvent.click(
    screen.getByText(zh['chatview.sources'].replace('{count}', String(sources.length)))
  )
}

beforeEach(() => {
  stubPocketai({})
  seen.length = 0
  sessionStorage.clear()
})

describe('Agent 卡片引用来源的跳转入口', () => {
  it('来源带 kbId/seq ⇒ 出现「查看原文」，点下去写 pending + 切模块 + 广播事件（顺序也要对）', () => {
    mountSources([src()])
    const btn = screen.getByLabelText(zh['chatview.viewSource'])
    fireEvent.click(btn)
    expect(JSON.parse(sessionStorage.getItem('kb-pending-source') || '{}')).toEqual({
      kbId: 'kb1',
      docId: 'd1',
      seq: 3
    })
    expect(seen).toEqual([
      { type: 'pocketai:switch-module', detail: { moduleId: 'knowledge' } },
      { type: 'kb-open-source' }
    ])
  })

  it('反向对照（A2 之前的老数据）：缺 kbId 就不给入口，别摆一个点了没反应的按钮', () => {
    mountSources([src({ kbId: undefined })])
    expect(screen.queryByLabelText(zh['chatview.viewSource'])).toBeNull()
  })

  it('反向对照：缺 seq 同样不给入口', () => {
    mountSources([src({ seq: undefined })])
    expect(screen.queryByLabelText(zh['chatview.viewSource'])).toBeNull()
  })

  it('seq=0 是真序号 ⇒ 入口要在，pending 里也得是数字 0（真值判断会把它吃掉）', () => {
    mountSources([src({ seq: 0 })])
    const btn = screen.getByLabelText(zh['chatview.viewSource'])
    fireEvent.click(btn)
    expect(JSON.parse(sessionStorage.getItem('kb-pending-source') || '{}').seq).toBe(0)
  })

  it('多条来源：每条各一个入口，跳转参数按各自的分块走', () => {
    mountSources([
      src({ chunkId: 'c1', kbId: 'kbA', docId: 'dA', seq: 1 }),
      src({ chunkId: 'c2', kbId: 'kbB', docId: 'dB', seq: 9 })
    ])
    const btns = screen.getAllByLabelText(zh['chatview.viewSource'])
    expect(btns).toHaveLength(2)
    fireEvent.click(btns[1]!)
    expect(JSON.parse(sessionStorage.getItem('kb-pending-source') || '{}')).toEqual({
      kbId: 'kbB',
      docId: 'dB',
      seq: 9
    })
  })

  it('混着老数据时只给能跳的那条入口（数量对得上，不留空按钮）', () => {
    mountSources([src({ chunkId: 'c1', kbId: undefined }), src({ chunkId: 'c2' })])
    expect(screen.getAllByLabelText(zh['chatview.viewSource'])).toHaveLength(1)
  })

  it('折叠态下不渲染条目与入口（点了标题才出现）', () => {
    const m: AgentMessage = { id: 'a1', role: 'assistant', text: '答案', sources: [src()] }
    mountWithProviders(<AgentMessageCard m={m} />)
    expect(screen.queryByLabelText(zh['chatview.viewSource'])).toBeNull()
  })
})
