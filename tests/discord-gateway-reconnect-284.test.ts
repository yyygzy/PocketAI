// discord-gateway socket 生命周期测试（V4-Iter-284）
//
// 覆盖两条缺陷修复：
// - Fix A（"运行中意外断开：尝试重连"那一支原本恒假）：close handler 先 `cleanupConnection()` 把
//   running 清成 false，随后 `if (this.running)` 永远走不到 ⇒ discord 从上线起没跑过一次意外断开重连。
//   现在 cleanup 之前先捕获 `wasRunning`／`wasStarting`，用它判分支。
// - Fix B（op9 invalid-session 那 2 秒 setTimeout 的 stale identify）：把 2 秒后的重 identify
//   挂进 `pendingIdentifyTimer` 字段，`cleanupConnection` 会撤销它 ⇒ 期间 socket 关的话，
//   由 reconnect 起的新 socket 从 Hello 走一次正常 identify，不再被 stale timer 追加一枪。
//
// 策略：
// - vi.stubGlobal 把 WebSocket 换成 FakeWebSocket（instance 记录 url / readyState / sentPayloads / listeners）
// - 假服务端事件（open / Hello / READY / op9 / close）用 dispatch 手动驱动
// - vi.useFakeTimers 精准等 2 秒与 1 秒 backoff，避免真等
// - 每用例 `vi.resetModules()` 起一份新 singleton（`discordGateway` 是模块级实例）
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------- Fake WebSocket ----------

class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  url: string
  readyState: number // 0=CONNECTING, 1=OPEN, 2=CLOSING, 3=CLOSED
  // gateway 里用 `this.ws.OPEN` 判（实例上挂一份，与 Node 内置 WebSocket 形状对齐）
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
    (this.listeners[type] ??= []).push(cb)
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

  // ---- 测试驱动 helpers ----
  fireOpen(): void {
    this.readyState = this.OPEN
    this.dispatch('open')
  }
  fireHello(heartbeatIntervalMs = 45_000): void {
    this.dispatch('message', {
      data: JSON.stringify({ op: 10, s: null, t: null, d: { heartbeat_interval: heartbeatIntervalMs } })
    })
  }
  fireInvalidSession(): void {
    this.dispatch('message', {
      data: JSON.stringify({ op: 9, s: 2, t: null, d: false })
    })
  }
  fireRaw(payload: unknown): void {
    this.dispatch('message', { data: JSON.stringify(payload) })
  }
  // 数 gateway 发出去的 op2（identify）帧数
  sentIdentifies(): number {
    return this.sentPayloads.filter((p) => {
      try {
        return (JSON.parse(p) as { op?: number }).op === 2
      } catch {
        return false
      }
    }).length
  }
}

// ---------- module mocks ----------

const mocks = vi.hoisted(() => ({
  token: 'discord-test-token-abc'
}))

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

beforeEach(() => {
  FakeWebSocket.instances = []
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', FakeWebSocket as unknown as typeof WebSocket)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('§284 Fix A：运行中意外断开走 reconnect（原本这一支恒假）', () => {
  it('READY 后非主动 close（code 1006）⇒ backoff 之后起一条新 WebSocket', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    const ws0 = FakeWebSocket.instances[0]!
    expect(ws0).toBeDefined()
    ws0.fireOpen()
    ws0.fireHello()
    ws0.fireRaw({
      op: 0,
      s: 1,
      t: 'READY',
      d: { user: { id: 'u1', username: 'bot' }, session_id: 's1' }
    })
    expect(gw.isRunning()).toBe(true)
    const before = FakeWebSocket.instances.length
    // abnormal closure：code < 4000，非 stop 触发
    ws0.close(1006)
    // reconnect 里 sleep(1000) 之后 connect → new WebSocket
    await vi.advanceTimersByTimeAsync(1_200)
    expect(FakeWebSocket.instances.length).toBeGreaterThan(before)
    gw.stop()
  })

  it('反向对照：握手阶段 close ⇒ 走 starting 那一支，起 error 状态、不 reconnect', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    const ws0 = FakeWebSocket.instances[0]!
    // 只 fireOpen，不发 Hello/READY ⇒ starting 仍为 true、running 从未 true
    ws0.fireOpen()
    const before = FakeWebSocket.instances.length
    const events: Array<{ status: string }> = []
    gw.onStatus((e) => events.push({ status: e.status as string }))
    ws0.close(1006)
    await vi.advanceTimersByTimeAsync(3_000)
    // starting 那一支：不 reconnect ⇒ 没有新 WebSocket 实例
    expect(FakeWebSocket.instances.length).toBe(before)
    expect(events.some((e) => e.status === 'error')).toBe(true)
    gw.stop()
  })
})

describe('§284 Fix B：op9 invalid-session 那 2 秒 setTimeout', () => {
  it('保活：2 秒到点 socket 仍 OPEN ⇒ identify 补一枪（原有 happy path 不回归）', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    const ws0 = FakeWebSocket.instances[0]!
    ws0.fireOpen()
    ws0.fireHello() // 这里 identify 发一次
    ws0.fireRaw({
      op: 0,
      s: 1,
      t: 'READY',
      d: { user: { id: 'u1', username: 'bot' }, session_id: 's1' }
    })
    expect(ws0.sentIdentifies()).toBe(1)
    ws0.fireInvalidSession()
    // 未到点：还没补发
    await vi.advanceTimersByTimeAsync(1_999)
    expect(ws0.sentIdentifies()).toBe(1)
    // 到点：补一枪
    await vi.advanceTimersByTimeAsync(2)
    expect(ws0.sentIdentifies()).toBe(2)
    gw.stop()
  })

  it('关在 2 秒内：pending timer 撤销，reconnect 起的新 socket 只 identify 一次（原实现会被补第二枪）', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    const ws0 = FakeWebSocket.instances[0]!
    ws0.fireOpen()
    ws0.fireHello()
    ws0.fireRaw({
      op: 0,
      s: 1,
      t: 'READY',
      d: { user: { id: 'u1', username: 'bot' }, session_id: 's1' }
    })
    expect(ws0.sentIdentifies()).toBe(1)
    // t=0：op9 排 2 秒 setTimeout（Fix B 挂进 pendingIdentifyTimer；变异轮里它是裸 setTimeout）
    ws0.fireInvalidSession()
    // t=100：close 非主动 ⇒ cleanup 撤 pending timer（Fix B）＋ wasRunning=true ⇒ reconnect 排 sleep(1000) → target t=1100
    await vi.advanceTimersByTimeAsync(100)
    ws0.close(1000)
    // t=1100：新 socket 起来，测试手动 fireOpen/fireHello ⇒ ws1 走正常握手 identify
    await vi.advanceTimersByTimeAsync(1_000)
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2)
    const ws1 = FakeWebSocket.instances[1]!
    ws1.fireOpen()
    ws1.fireHello()
    expect(ws1.sentIdentifies()).toBe(1)
    // 再跑到 t=2100：op9 那发 2 秒 setTimeout 若在（变异轮）就会在 ws1.OPEN 上补第二枪
    await vi.advanceTimersByTimeAsync(1_000)
    expect(ws1.sentIdentifies()).toBe(1) // 撤销成功、没有第二发
    gw.stop()
  })

  it('stop 时 pending timer 撤销 ⇒ fake 时钟队列里没有残留 setTimeout 在跑', async () => {
    const gw = await freshGateway()
    await gw.start(() => {})
    const ws0 = FakeWebSocket.instances[0]!
    ws0.fireOpen()
    ws0.fireHello() // identify 1 发（心跳 setInterval 也起了）
    ws0.fireRaw({
      op: 0,
      s: 1,
      t: 'READY',
      d: { user: { id: 'u1', username: 'bot' }, session_id: 's1' }
    })
    expect(ws0.sentIdentifies()).toBe(1)
    ws0.fireInvalidSession()
    // 现在挂钟上：心跳 setInterval + op9 setTimeout = 2 个 pending timer
    gw.stop()
    // stop→abort→close handler 里 cleanupConnection（撤 pendingIdentifyTimer + clearInterval heartbeat）→ 队列应清空
    // 变异轮里撤掉 Fix B 的 clear ⇒ pendingIdentifyTimer 仍在 ⇒ 这一断言红
    expect(vi.getTimerCount()).toBe(0)
    // 时间跑过 2 秒：stale timer 已被撤销，不会再 send
    await vi.advanceTimersByTimeAsync(2_200)
    expect(ws0.sentIdentifies()).toBe(1)
  })
})
