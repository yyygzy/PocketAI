// P2 / V4-Iter-459：队列结算的确定性用例（假事件流，不挂 React、不碰 IPC）
import { describe, expect, it } from 'vitest'
import {
  applyInterjectEvent,
  createRunSettlementLedger,
  settleRunQueue,
  type AgentQueueItem
} from '../src/renderer/src/modules/agent/queue-settlement'

interface FakeAgentEvent {
  requestId: string
  conversationId: string
  outcome: 'done' | 'error'
}

/** 假事件流：订阅者各自收事件；不订阅就是彻底不参与（模拟观测 hook 缺席） */
function createFakeStream(): {
  subscribe: (handler: (e: FakeAgentEvent) => void) => void
  emit: (e: FakeAgentEvent) => void
  listenerCount: () => number
} {
  const listeners: Array<(e: FakeAgentEvent) => void> = []
  return {
    subscribe(handler) {
      listeners.push(handler)
    },
    emit(e) {
      for (const handler of [...listeners]) handler(e)
    },
    listenerCount: () => listeners.length
  }
}

const item = (clientRef: string, interjecting = false, conversationId = 'c1'): AgentQueueItem => ({
  clientRef,
  conversationId,
  text: clientRef,
  interjecting
})

describe('P2 队列结算：观察者缺席也能 drain，双订阅不重复发送', () => {
  it('观测 hook 完全不订阅时，队列 hook 自己收 DONE 仍能 drain', () => {
    const stream = createFakeStream()
    let queue: AgentQueueItem[] = [item('q1'), item('q2')]
    const ledger = createRunSettlementLedger()
    const sent: string[] = []

    // 队列 hook 自己订阅（持有队列的 hook 就是队列主人，不依赖观测 hook）
    stream.subscribe((e) => {
      const result = settleRunQueue(
        queue,
        { conversationId: e.conversationId, requestId: e.requestId, autoSend: e.outcome === 'done', canAutoSend: true },
        ledger
      )
      queue = result.queue
      if (result.next) sent.push(result.next.clientRef)
    })
    expect(stream.listenerCount()).toBe(1)

    stream.emit({ requestId: 'req1', conversationId: 'c1', outcome: 'done' })
    expect(sent).toEqual(['q1'])
    expect(queue.map((q) => q.clientRef)).toEqual(['q2'])
  })

  it('队列订阅 + 观测订阅各结算一次同一轮：只发一条，旧快照也被 (requestId, clientRef) 拦住', () => {
    const stream = createFakeStream()
    let queue: AgentQueueItem[] = [item('q1'), item('q2')]
    const ledger = createRunSettlementLedger()
    const sent: string[] = []

    const settle = (e: FakeAgentEvent): void => {
      const result = settleRunQueue(
        queue,
        { conversationId: e.conversationId, requestId: e.requestId, autoSend: e.outcome === 'done', canAutoSend: true },
        ledger
      )
      queue = result.queue
      if (result.next) sent.push(result.next.clientRef)
    }
    // 两个订阅者（队列 owner + 观测 hook）都收到同一个 DONE
    stream.subscribe(settle)
    stream.subscribe(settle)
    expect(stream.listenerCount()).toBe(2)

    stream.emit({ requestId: 'req1', conversationId: 'c1', outcome: 'done' })
    expect(sent).toEqual(['q1'])

    // 若第二个订阅者拿到的是旧队列快照（q1 仍在），账本必须拦住重复发送
    const stale = [item('q1'), item('q2')]
    const replay = settleRunQueue(
      stale,
      { conversationId: 'c1', requestId: 'req1', autoSend: true, canAutoSend: true },
      ledger
    )
    expect(replay.next).toBeNull()
  })

  it('出错/后台会话只归位不自动发；插队中但没收到事件的一律退回普通排队', () => {
    const ledger = createRunSettlementLedger()
    const result = settleRunQueue(
      [item('q1', true), item('q2', false)],
      { conversationId: 'c1', requestId: 'req1', autoSend: false, canAutoSend: true },
      ledger
    )
    expect(result.next).toBeNull()
    expect(result.queue.map((q) => q.interjecting)).toEqual([false, false])
  })

  it('canAutoSend=false 时同样不发，队列条目留在原位等下次正常发送', () => {
    const ledger = createRunSettlementLedger()
    const result = settleRunQueue(
      [item('q1')],
      { conversationId: 'c1', requestId: 'req1', autoSend: true, canAutoSend: false },
      ledger
    )
    expect(result.next).toBeNull()
    expect(result.queue.map((q) => q.clientRef)).toEqual(['q1'])
  })

  it('interject 事件按 clientRef 幂等：重复到达结果不变，旧快照也不会留下条目', () => {
    const once = applyInterjectEvent([item('q1', true), item('q2', true)], 'q1')
    const twice = applyInterjectEvent(once, 'q1')
    expect(once.map((q) => q.clientRef)).toEqual(['q2'])
    expect(twice.map((q) => q.clientRef)).toEqual(['q2'])
    // 旧快照再对一次账：仍然只剩 q2
    expect(applyInterjectEvent([item('q1', true), item('q2', true)], 'q1').map((q) => q.clientRef)).toEqual([
      'q2'
    ])
  })
})
