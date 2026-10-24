// 本地槽位队列 abort 监听器交棒路径测试（V4-Iter-305）
//
// 缺陷：SlotQueue.acquire() 满员时把 onAbort 挂到调用方传进来的 signal 上（`{ once:true }`）。
// 两条退出路径不对称——
//   - abort 路径：onAbort 触发时 reject + splice，`once:true` 顺带自摘 ⇒ 干净。
//   - 交棒（granted）路径：`release()→pickNext()` 把 waiter 从队列 splice 掉、调 `next.resolve()`，
//     但 signal 上那条 onAbort **没人摘**（`once` 只在 abort 事件真发生时才自摘，被放行时事件没发生）。
// 传进来的 signal 是**一次 run 复用的那根 master**（openai-compatible.streamChat 把 params.signal
// 透传进闸门，agent/chat 一 run 内所有步共用），于是每"排队再被放行"一次就在它上面净累加一个监听器、
// 闭包还钉住一个已结的 waiter。与已修的 lock.ts(onAppHidden)/四网关(connect) 是同族不对称。
//
// 修法：把 waiter.resolve 包一层——交棒成功时先 `signal.removeEventListener('abort', onAbort)` 再 resolve。
//
// 判据：getEventListeners(signal,'abort').length（注意 node:events 的 listenerCount 对 AbortSignal 恒返 0，
// 数不到，见 §304 教训）。用真 signal + 真闸门，但把闸门里的"推理"换成手里可控的 hold promise，
// 不必起 HTTP 服务（isLocalInferenceBaseUrl 只要回环地址就放行排队逻辑）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getEventListeners } from 'node:events'

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

import {
  configureLocalSlot,
  resetLocalSlotsForTest,
  withLocalSlot,
  localSlotSnapshot,
  type SlotRequest
} from '../src/main/providers/local-slot'

const LOCAL = 'http://127.0.0.1:11434/v1' // 回环 ⇒ isLocalInferenceBaseUrl true
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function until(cond: () => boolean, msg: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await tick()
  }
  throw new Error(msg)
}
const q0 = () => localSlotSnapshot()[0]
const abortListeners = (sig: AbortSignal): number => getEventListeners(sig, 'abort').length

// 手里可控的一条"推理"：fn 返回一个由测试决定何时了结的 promise（不碰网络）
function controllable(): { run: () => Promise<void>; finish: () => void } {
  let finish!: () => void
  const run = () => new Promise<void>((r) => (finish = r))
  return { run, finish: () => finish() }
}

beforeEach(() => {
  resetLocalSlotsForTest()
  configureLocalSlot({ readVramMiB: () => 4096 }) // ≤4GiB 实测档 ⇒ 排队、对话槽=1
})
afterEach(() => {
  resetLocalSlotsForTest()
})

describe('§305 SlotQueue 交棒(granted)路径摘掉排队期挂的 abort 监听器', () => {
  it('A 占槽 → B 在同一 signal 上排队（监听器=1 正向对照）→ 交棒给 B 后必须归 0（修前=1）', async () => {
    const ctrl = new AbortController()
    const sig = ctrl.signal
    const A = controllable()
    const B = controllable()

    // A 走快路径（busy 0→1，不挂任何监听器）
    const pA = withLocalSlot({ baseUrl: LOCAL, lane: 'chat', label: 'A', signal: sig } as SlotRequest, A.run)
    await until(() => q0()?.busy === 1, 'A 没占住槽')
    expect(abortListeners(sig), 'A 走快路径不该在 signal 上留东西').toBe(0)

    // B 满员 ⇒ 进队列，此刻它那条 onAbort 是正当的（还在等、可被取消）
    const pB = withLocalSlot({ baseUrl: LOCAL, lane: 'chat', label: 'B', signal: sig } as SlotRequest, B.run)
    await until(() => q0()?.waiting === 1, 'B 没进队列')
    expect(abortListeners(sig), 'B 排队期间该有且只有它自己那一条').toBe(1)

    // A 了结 ⇒ release ⇒ pickNext 交棒 ⇒ B 的 resolve 包装先摘掉 onAbort 再放行
    A.finish()
    await pA
    await until(() => q0()?.waiting === 0 && q0()?.busy === 1, 'B 没被交棒放行')
    // B 正在跑（自己的 hold 未了结），但它已不在队列 ⇒ 排队期那条必须已被摘掉
    expect(abortListeners(sig), 'B 已放行，排队期挂的 onAbort 必须摘干净（修前这里=1）').toBe(0)

    B.finish()
    await pB
    expect(abortListeners(sig), 'run 收尾时这根 signal 上一条监听器都不该剩').toBe(0)
    ctrl.abort()
  })

  it('反向：B 排队途中 abort ⇒ reject 且监听器归 0（once 自摘那条路没被改坏）', async () => {
    const ctrl = new AbortController()
    const sig = ctrl.signal
    const A = controllable()
    const B = controllable()

    const pA = withLocalSlot({ baseUrl: LOCAL, lane: 'chat', label: 'A', signal: sig } as SlotRequest, A.run)
    await until(() => q0()?.busy === 1, 'A 没占住槽')

    const pB = withLocalSlot({ baseUrl: LOCAL, lane: 'chat', label: 'B', signal: sig } as SlotRequest, B.run)
    await until(() => q0()?.waiting === 1, 'B 没进队列')
    expect(abortListeners(sig), 'B 排队中该有它那一条').toBe(1)

    // 取消整个 run：B 应 reject（AbortError），且 once 自摘 ⇒ 不留监听器
    ctrl.abort()
    await expect(pB).rejects.toThrow(/aborted/i)
    expect(abortListeners(sig), 'abort 路径自己就该摘干净').toBe(0)

    A.finish()
    await pA.catch(() => undefined) // A 的 signal 也已 abort，收尾即可
    expect(q0()?.waiting ?? 0).toBe(0)
  })
})
