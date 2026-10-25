// 持槽后、进释放 finally 之前抛出的放槽测试（V4-Iter-308）
//
// 缺陷：withLocalSlot() 在 `await queue.acquire()` 成功之后**就已经占住槽**，可释放只挂在更下面的
// `try { …fn… } finally { queue.release() }` 上；中间那段（算 waited + 慢等待埋点 deps.recordWait，
// index.ts 接的是 recordPerf）在 try **外**。它一抛 ⇒ 错冒出去、finally 从没进入 ⇒ busy 永远多占 1。
// 实测档（≤4GiB）对话槽=1 ⇒ 这台机的队列从此**死锁**：之后每个本地推理都排队不起跑，直到应用重启。
//
// 修法（不能图省事把 acquire 挪进 try——见用例②）：acquire 留在 try 外，
// 只把"已持槽之后"这段包进 try/catch，抛时先 `queue.release()` 再把原错抛出去。
//
// 判据用可观测的队列状态（localSlotSnapshot 的 busy），不读私有字段；时钟用 setSlotClockForTest 固定，
// 让 waited 确定性地跨过 500ms 阈值（SLOW_WAIT_PERF_MS），不必真等。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

import {
  configureLocalSlot,
  resetLocalSlotsForTest,
  setSlotClockForTest,
  withLocalSlot,
  localSlotSnapshot,
  type SlotRequest
} from '../src/main/providers/local-slot'

const LOCAL = 'http://127.0.0.1:11434/v1'
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(cond: () => boolean, msg: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(msg)
}
const q0 = () => localSlotSnapshot()[0]

function controllable(): { run: () => Promise<void>; finish: () => void } {
  let finish!: () => void
  const run = () => new Promise<void>((r) => (finish = r))
  return { run, finish: () => finish() }
}
const req = (label: string, signal?: AbortSignal): SlotRequest =>
  ({ baseUrl: LOCAL, lane: 'chat', label, signal }) as unknown as SlotRequest

/** recordWait：只对 model=B 那一条抛（模拟 perf 记录器在慢等待埋点上报错） */
function throwingRecorder(): (ms: number, detail: string) => void {
  return (_ms: number, detail: string): void => {
    if (/model=B/.test(detail)) throw new Error('PERF_RECORDER_BOOM')
  }
}

let now = 0
beforeEach(() => {
  resetLocalSlotsForTest()
  now = 0
  setSlotClockForTest(() => now)
})
afterEach(() => {
  resetLocalSlotsForTest()
})

describe('§308 已持槽后抛出必须放槽，否则容量 1 的队列死锁', () => {
  it('慢等待埋点抛 ⇒ 错误照冒，但槽要还回来（busy 回 0），下一个请求照常能跑（修前 busy 永远 1）', async () => {
    configureLocalSlot({ readVramMiB: () => 4096, recordWait: throwingRecorder() })
    const A = controllable()
    const B = controllable()

    const pA = withLocalSlot(req('A'), A.run)
    await until(() => q0()?.busy === 1, 'A 没占住槽')

    now += 10
    const pB = withLocalSlot(req('B'), B.run) // startedAt=10，排队
    await until(() => q0()?.waiting === 1, 'B 没进队列')

    now += 1000 // A 了结后 B 的 waited = 1000 ≥ 500 ⇒ 一定会调 recordWait
    A.finish()
    await pA

    await expect(pB).rejects.toThrow(/PERF_RECORDER_BOOM/) // 原错不许被咽掉
    await until(() => q0()?.busy === 0, 'B 抛错后槽没还回来 ⇒ 队列死锁（修前就卡在这里）')

    // 活口验证：第三个请求还能拿到槽并跑完
    const C = controllable()
    const pC = withLocalSlot(req('C'), C.run)
    await until(() => q0()?.busy === 1, '死锁没解除：C 拿不到槽')
    C.finish()
    await pC
    expect(q0()?.busy).toBe(0)
  })

  it('反向对照（守住"把 acquire 挪进 try"那种错修）：排队途中 abort ⇒ 槽本来就没到手，不许 release 误减 busy', async () => {
    configureLocalSlot({ readVramMiB: () => 4096, recordWait: () => {} })
    const A = controllable()
    const ctrlB = new AbortController()

    const pA = withLocalSlot(req('A'), A.run)
    await until(() => q0()?.busy === 1, 'A 没占住槽')

    const pB = withLocalSlot(req('B', ctrlB.signal), () => Promise.resolve())
    await until(() => q0()?.waiting === 1, 'B 没进队列')

    ctrlB.abort()
    await expect(pB).rejects.toThrow(/aborted/i)

    // A 仍独占那张卡：B 只是排队、从未持槽 ⇒ busy 必须还是 1（若被误减成 0，等于放走了不存在的槽）
    expect(q0()?.busy, '未持槽的 abort 不许释放 busy').toBe(1)

    A.finish()
    await pA
    await until(() => q0()?.busy === 0, 'A 正常收尾后槽应归还')
  })
})
