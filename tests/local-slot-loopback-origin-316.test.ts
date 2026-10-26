// V4-Iter-316：本地槽位的队列键必须与「是不是本机」那条判据同轴
//
// 缺陷形状：闸门判回环用主机名（不含端口、六种写法都算本机），键却取 `URL.host`
// （含端口、写法敏感）⇒ 同一个服务器的 `localhost:11434` 与 `127.0.0.1:11434` 各排一条
// 容量 1 的队，「同一张卡同时只放一路生成」对那个配置静默失效。
//
// 判据取公开可观测的下游后果，不读私有字段：
//   · 同时在飞几条（peak）——串行 ⇒ 1，分家 ⇒ 2
//   · `localSlotSnapshot()` 的 origin 名单——判据屏那一行读的就是这个串
// 反向对照钉住"不许折过头"：端口、跨机都不许并进同一条队。
import { describe, it, expect, afterEach } from 'vitest'
import {
  withLocalSlot,
  localSlotSnapshot,
  resetLocalSlotsForTest,
  setSlotDecisionForTest,
  type SlotLane
} from '../src/main/providers/local-slot'
import type { LocalCapacityDecision } from '../src/main/agent/local-capacity'

// 实测档（entry-4g）才会套槽；容量 1 是这张卡唯一有实测数据的结论
const MEASURED: LocalCapacityDecision = {
  maxConcurrentChatSlots: 1,
  allowChatEmbedOverlap: false,
  rolesMayUseDistinctModels: false,
  measured: true,
  bucket: 'entry-4g',
  reasons: ['measured-bucket']
}

let inFlight = 0
let peak = 0
const releases: Array<() => void> = []

/** 进闸门就挂住，直到测试逐个放行——这样"同时在飞几条"是能直接读出来的事实 */
function hit(baseUrl: string, lane: SlotLane = 'chat'): Promise<void> {
  return withLocalSlot({ baseUrl, lane, label: 'probe' }, () =>
    new Promise<void>((resolve) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      releases.push(() => {
        inFlight--
        resolve()
      })
    })
  )
}

/** 让排队中的下一条真跑起来（交棒要过两层微任务，setTimeout(0) 才刷得干净） */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

async function drainAll(): Promise<void> {
  while (releases.length > 0) {
    releases.shift()!()
    await settle()
  }
}

const origins = () => localSlotSnapshot().map((s) => s.origin).sort()

afterEach(() => {
  resetLocalSlotsForTest()
  inFlight = 0
  peak = 0
  releases.length = 0
})

describe('local-slot — 回环端点的队列键（§316）', () => {
  it('localhost 与 127.0.0.1 同一个服务器 ⇒ 共排队，峰值 1，且只剩一条队', async () => {
    setSlotDecisionForTest(() => MEASURED)
    const a = hit('http://localhost:11434/v1')
    await settle()
    const b = hit('http://127.0.0.1:11434/v1')
    await settle()
    expect(peak).toBe(1)
    // 判据屏那一行读到的串：折出来是用户本来就会写的主机名，不是内部行话
    expect(origins()).toEqual(['localhost:11434'])
    await drainAll()
    await Promise.all([a, b])
  })

  it('chat 与 embedding 跨写法仍互斥（M10：一 embed 就把对话模型顶出去）', async () => {
    setSlotDecisionForTest(() => MEASURED)
    const a = hit('http://localhost:11434/v1', 'chat')
    await settle()
    const b = hit('http://127.0.0.1:11434/v1', 'embedding')
    await settle()
    expect(peak).toBe(1)
    await drainAll()
    await Promise.all([a, b])
  })

  it('IPv6 回环写法也折进同一条队', async () => {
    setSlotDecisionForTest(() => MEASURED)
    const a = hit('http://[::1]:11434/v1')
    await settle()
    const b = hit('http://localhost:11434/v1')
    await settle()
    expect(peak).toBe(1)
    expect(origins()).toEqual(['localhost:11434'])
    await drainAll()
    await Promise.all([a, b])
  })

  it('缺协议与大写写法也同键（闸门早就按主机名认回环，键不许另判一套）', async () => {
    setSlotDecisionForTest(() => MEASURED)
    const a = hit('localhost:11434/v1')
    await settle()
    const b = hit('http://LOCALHOST:11434/v1')
    await settle()
    expect(peak).toBe(1)
    expect(origins()).toEqual(['localhost:11434'])
    await drainAll()
    await Promise.all([a, b])
  })

  it('反向对照①：同机两个端口不许折成一条队（11434 与 1234 是两个各自加载模型的服务）', async () => {
    setSlotDecisionForTest(() => MEASURED)
    const a = hit('http://localhost:11434/v1')
    await settle()
    const b = hit('http://localhost:1234/v1')
    await settle()
    expect(origins()).toEqual(['localhost:11434', 'localhost:1234'])
    expect(peak).toBe(2)
    await drainAll()
    await Promise.all([a, b])
  })

  it('反向对照②：局域网另一台机器不套槽，也不许和本机共队', async () => {
    setSlotDecisionForTest(() => MEASURED)
    const a = hit('http://192.168.1.5:11434/v1')
    await settle()
    const b = hit('http://127.0.0.1:11434/v1')
    await settle()
    // 非回环那条一行时序都不改 ⇒ 名单里只有本机这一条
    expect(origins()).toEqual(['localhost:11434'])
    expect(peak).toBe(2)
    await drainAll()
    await Promise.all([a, b])
  })
})
