// 渠道网关 abort 监听器累加测试（V4-Iter-304）
//
// 缺陷：每家 socket 网关的 run() 只建**一个** AbortController（`this.ctrl`），
// 而 connect() 每次往 `ctrl.signal` 上 `addEventListener('abort', onAbort, { once:true })`。
// 意外断开走 reconnect 时用的是**同一个 ctrl**（close handler 把 run() 里的 ctrl 透传进去），
// 于是每重连一次就在长命 signal 上净累加一个 once 监听器——`once` 只在 signal 真 abort 时才自摘，
// 运行期 never fire ⇒ 旧监听器一直挂着，各自闭包又钉住一个已关的 WebSocket 不进 GC。
// 同模块的兄弟 sleep() 自己在 done() 里 removeEventListener，connect() 此前漏了（不对称即铁证）。
//
// 修复：每条 socket 的 close handler 第一句 `ctrl.signal.removeEventListener('abort', onAbort)`
// ——socket 一关，它的 onAbort 就没有存在意义了（唯一职责是"stop 时把这条还开着的 socket 关掉"）。
//
// 判据：用 node:events 的 getEventListeners(signal,'abort') 现数 gateway 自己那个 ctrl.signal 上的
// 存活监听器数（注意：events.listenerCount 对 EventTarget 恒返 0，数不到，别用它）。
// 驱动两次「running 后异常 close ⇒ reconnect」＝三次 connect() ⇒ 修后只剩当前那一条=1，修前三条=3。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getEventListeners } from 'node:events'

// ---------- Fake WebSocket（照抄 §284 那份能驱动重连的形状）----------
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState: number
  readonly OPEN = 1
  readonly CLOSED = 3
  private listeners: Record<string, Array<(ev: unknown) => void>> = {}
  sentPayloads: string[] = []

  constructor(url: string) {
    this.url = url
    this.readyState = 0
    FakeWebSocket.instances.push(this)
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    ;(this.listeners[type] ??= []).push(cb)
  }
  dispatch(type: string, ev: unknown = {}): void {
    for (const cb of this.listeners[type] ?? []) cb(ev)
  }
  send(data: string): void {
    if (this.readyState !== this.OPEN) throw new Error('send on non-OPEN socket')
    this.sentPayloads.push(data)
  }
  close(code = 1000, reason = ''): void {
    this.readyState = this.CLOSED
    this.dispatch('close', { code, reason })
  }
  fireOpen(): void {
    this.readyState = this.OPEN
    this.dispatch('open')
  }
  fireHello(heartbeatIntervalMs = 45_000): void {
    this.dispatch('message', {
      data: JSON.stringify({ op: 10, s: null, t: null, d: { heartbeat_interval: heartbeatIntervalMs } })
    })
  }
  fireReady(): void {
    this.dispatch('message', {
      data: JSON.stringify({ op: 0, s: 1, t: 'READY', d: { user: { id: 'u1', username: 'bot' }, session_id: 's1' } })
    })
  }
}

const mocks = vi.hoisted(() => ({ token: 'discord-test-token-abc' }))

vi.mock('../src/main/channels/channel-config', () => ({
  getChannelSecrets: () => ({ primary: mocks.token, whitelist: [] }),
  getChannelConfig: () => ({ enabled: true })
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

async function freshGateway(): Promise<import('../src/main/channels/gateway-base').IGateway> {
  vi.resetModules()
  const mod = await import('../src/main/channels/discord-gateway')
  return mod.discordGateway
}

// gateway 自己的那个长命 ctrl.signal（run() 里 new、之后 reconnect 复用它）
function liveAbortListeners(gw: unknown): number {
  const ctrl = (gw as { ctrl: AbortController | null }).ctrl
  expect(ctrl, 'start() 之后 this.ctrl 必须存在').not.toBeNull()
  return getEventListeners(ctrl!.signal, 'abort').length
}

// 走完 open→hello→READY 让 running=true，随后异常 close 才会走 reconnect 那一支
async function bringUpAndCrash(index: number): Promise<void> {
  const ws = FakeWebSocket.instances[index]!
  ws.fireOpen()
  ws.fireHello()
  ws.fireReady()
  ws.close(1006) // abnormal closure, code<4000, 非 stop 触发 ⇒ reconnect
}

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('§304 socket 网关 abort 监听器不随 reconnect 累加', () => {
  it('initial start：connect 一次 ⇒ signal 上恰有一条 abort 监听器（正向对照，非零基线）', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    expect(liveAbortListeners(gw)).toBe(1)
    gw.stop()
  })

  it('两次 running-crash 重连（共三条 socket）⇒ signal 上仍只剩当前那一条（修前这里是 3）', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    expect(FakeWebSocket.instances.length).toBe(1)

    // cycle 1：ws0 up→crash，backoff 1000ms 后 reconnect 起 ws1
    await bringUpAndCrash(0)
    await vi.advanceTimersByTimeAsync(1_200)
    expect(FakeWebSocket.instances.length).toBe(2)
    expect(liveAbortListeners(gw), '一次重连后就该从 2 收敛回 1（修前=2）').toBe(1)

    // cycle 2：ws1 up→crash，再 reconnect 起 ws2
    await bringUpAndCrash(1)
    await vi.advanceTimersByTimeAsync(1_200)
    expect(FakeWebSocket.instances.length).toBe(3)
    expect(liveAbortListeners(gw), '三条 socket 后仍只剩 1（修前=3，监听器只增不减）').toBe(1)

    gw.stop()
  })

  it('反向对照：握手阶段 close（非 running）也照样把自己那条摘掉，不靠 stop 兜底', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    // 只 fireOpen，不发 READY ⇒ running 恒 false、starting=true；close 走 starting 那一支、不 reconnect
    const ws0 = FakeWebSocket.instances[0]!
    ws0.fireOpen()
    expect(liveAbortListeners(gw)).toBe(1)
    ws0.close(1006)
    await vi.advanceTimersByTimeAsync(500)
    // starting 那一支不起重连 ⇒ 没有第二条；但这条 socket 的 close handler 已把自己的 onAbort 摘干净
    expect(FakeWebSocket.instances.length).toBe(1)
    expect(liveAbortListeners(gw), 'socket 关了它的监听器就该没了（修前残留=1）').toBe(0)
    gw.stop()
  })
})
