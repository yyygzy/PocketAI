// 本地推理槽位（V4-Iter-141）——把"同一张卡同时只放一路生成"收到唯一的出口上
//
// 为什么闸门在适配器而不是那十几个调用点：本仓所有本地推理流量最终都走 `openai-compatible.ts`
// 的三条推理端点（/chat/completions、/embeddings、/images/generations），
// 而调用点实测是 12 处 streamChat + 2 处 embed（方案初稿那份清单还漏了 ask-service 与 translate-service）。
// 逐个包 = 漏一个就静默失效（V4-Iter-139 那批"没接线"的同族形状）；收在出口，漏不了。
//
// 三条硬约束来自 V-0 实测，不是推理：
//   · M10 —— 4GiB 卡上对话模型与 embedding 模型**不同驻**（权重合计 2.7GiB < 4GiB 仍互相顶出，
//     被顶出后下一步付 3045ms 冷启动）⇒ chat 与 embedding 共用一条队，不是各排各的队。
//   · M6 —— 跨模型并发不比串行快（7597ms vs 8283ms，差 686ms 属噪声）⇒ 串行不损失吞吐。
//   · M5 —— 后台一条 embed 把同一条生成从 3731ms 拖到 6103ms（+64%）⇒ 排队买的是"可解释"，不是更快。
//
// 未实测档一律**不套槽**（用户 2026-10-15 选定）：判据没测过的卡（>4GiB / 采不到）与今天完全一致，
// 免得把"我们没有数据"实现成"用户变慢"。
import { AsyncLocalStorage } from 'node:async_hooks'
import { isLoopbackHost, urlHost } from '../../shared/url-policy'
import { planLocalCapacity, type LocalCapacityDecision } from '../agent/local-capacity'

/** 谁在提这个请求。默认前台；后台索引 / OCR / 自动标题由调用链的作用域标明 */
export type SlotKind = 'foreground' | 'background'

/** 端点类别：小卡上 chat 与 embedding 必须共用一条队（M10） */
export type SlotLane = 'chat' | 'embedding' | 'image'

const KIND_RANK: Record<SlotKind, number> = { foreground: 0, background: 1 }

/**
 * 后台任务等待超过这个时长就升级为与前台同级（用户选定的饿死保护）。
 * 没有它，"前台一直在聊"可以永久压住索引队列——那比慢更糟。
 */
export const BACKGROUND_PROMOTE_MS = 60_000

/** 等待到这才记一条 perf（正常排队不值得占环形缓冲） */
const SLOW_WAIT_PERF_MS = 500

/** perf 标签由本模块定义、由 composition root 落到 recordPerf——本模块不许静态依赖 logger 链 */
export const SLOT_WAIT_PERF_LABEL = 'local.slot.wait'

const kindStore = new AsyncLocalStorage<SlotKind>()
/** 重入标记：闸门本身已经在这条链上持有槽时，内层再进来不许二次排队（容量 1 时二次排队 = 自锁） */
const heldStore = new AsyncLocalStorage<boolean>()

export function currentSlotKind(): SlotKind {
  return kindStore.getStore() ?? 'foreground'
}

/**
 * 把一段工作标成某种槽位类别。用 AsyncLocalStorage 而不是给 12 个调用点各加一个参数：
 * "我在替后台索引干活"是**任务级**事实（只有 index-queue 与标题升级知道），
 * 一路透传到最深的 adapter 反而最容易漏、也最难证明没漏。
 */
export function runInSlotKind<T>(kind: SlotKind, fn: () => T): T {
  return kindStore.run(kind, fn)
}

// ---------- 队列 ----------

interface Waiter {
  kind: SlotKind
  enqueuedAt: number
  state: 'queued' | 'granted'
  resolve: () => void
  reject: (e: Error) => void
}

function abortError(): Error {
  const e = new Error('Request aborted while queued')
  e.name = 'AbortError'
  return e
}

class SlotQueue {
  private busy = 0
  private waiters: Waiter[] = []

  constructor(readonly capacity: number) {}

  /**
   * 排队拿槽；resolve 时槽已归调用方。
   * **等待期间被取消 ⇒ 立刻退出队列**：用户点「停止」不该继续占着一个排队位，
   * 更不该在几十秒后才起跑（那会让"停止"看起来没生效）。
   */
  async acquire(kind: SlotKind, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw abortError()
    if (this.busy < this.capacity) {
      this.busy++
      return
    }
    let self!: Waiter
    await new Promise<void>((resolve, reject) => {
      self = { kind, enqueuedAt: nowFn(), state: 'queued', resolve, reject }
      this.waiters.push(self)
      const onAbort = (): void => {
        // 仍在队列里：直接摘掉并让 acquire 抛出 AbortError（不占槽，因此不需要 release）
        const i = this.waiters.indexOf(self)
        if (i >= 0) {
          this.waiters.splice(i, 1)
          reject(abortError())
        }
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** 归还并把槽直接交给下一个该跑的等待者（交棒时 busy 不变，避免出现"没人持有的空窗"） */
  release(): void {
    const next = this.pickNext()
    if (next) {
      next.state = 'granted'
      next.resolve()
      return
    }
    this.busy = Math.max(0, this.busy - 1)
  }

  private pickNext(): Waiter | null {
    if (this.waiters.length === 0) return null
    const now = nowFn()
    let best = -1
    let bestRank = Number.POSITIVE_INFINITY
    let bestAt = Number.POSITIVE_INFINITY
    for (let i = 0; i < this.waiters.length; i++) {
      const w = this.waiters[i]!
      // 等太久的后台升级为前台同级
      const effective: SlotKind =
        w.kind === 'background' && now - w.enqueuedAt >= promoteMs ? 'foreground' : w.kind
      const rank = KIND_RANK[effective]
      if (rank < bestRank || (rank === bestRank && w.enqueuedAt < bestAt)) {
        best = i
        bestRank = rank
        bestAt = w.enqueuedAt
      }
    }
    return best < 0 ? null : this.waiters.splice(best, 1)[0]!
  }

  get waitingCount(): number {
    return this.waiters.length
  }

  get busyCount(): number {
    return this.busy
  }
}

const queues = new Map<string, SlotQueue>()

/**
 * 队列按 **origin** 分：同一台机器上多条 provider 记录指的往往是同一张卡，必须共排队；
 * 不同 host 各自一条队（局域网另一台机器的显存不该让本机排队）。
 */
function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl
  }
}

function queueFor(origin: string, capacity: number): SlotQueue {
  let q = queues.get(origin)
  if (!q) {
    q = new SlotQueue(Math.max(1, capacity))
    queues.set(origin, q)
  }
  return q
}

// ---------- 判据输入（全部注入式：本模块不许静态依赖 electron/logger/hardware） ----------

export interface SlotDeps {
  /** 返回本机最大 cuda 显存（MiB）；null = 采不到。未接线时按"采不到"处理 ⇒ 不套槽 */
  readVramMiB: () => number | null
  /** 慢等待埋点。未接线时静默丢弃（排队照常工作，只是不进 perf 面板） */
  recordWait?: (ms: number, detail: string) => void
}

let deps: SlotDeps = { readVramMiB: () => null }

/**
 * 由 composition root（src/main/index.ts）在启动时接线。
 * 忘记接的后果是"闸门不生效"，与今天行为一致，所以不会坏数据；
 * 但也正因如此，CI 里有一条 scan 用例专门钉住"index.ts 必须调用 configureLocalSlot"。
 */
export function configureLocalSlot(next: SlotDeps): void {
  deps = next
  queues.clear()
}

let promoteMs = BACKGROUND_PROMOTE_MS
let nowFn: () => number = Date.now

/**
 * 测试缝：整份替换判据。存在的理由不是"方便"，而是**今天真硬件到不了那一支**——
 * `rolesMayUseDistinctModels` 需要应用显式设小 num_ctx（全仓零命中），所以跨模型角色那条路
 * 在实机上永远是关的；没有这个缝，145 的"放行时会发出第二次推理"就没法被证，
 * 而"只测拒绝半边"的用例删掉放行分支照样全绿（144 的 M5 就是这么撞出来的）。
 * 生产代码不许调它（`resetLocalSlotsForTest` 会清，用例之间不残留）。
 */
let decisionOverride: (() => LocalCapacityDecision) | null = null

export function setSlotDecisionForTest(fn: (() => LocalCapacityDecision) | null): void {
  decisionOverride = fn
  queues.clear()
}

/**
 * 容量判据的唯一来源；每次请求现取，避免把启动瞬间的显存快照当永久事实。
 * `capacitySnapshot()` 是本模块内部实现，闸门只关心决策；**判据屏要同时报"用的哪个总量"，
 * 所以那边调 `capacitySnapshot()`**——总量与决策必须来自同一次读取，不能各读各的（否则界面上
 * 说的总量与闸门实际据以判定的总量可能不是同一个数，那正是 118 那族"两处口径"的形状）。
 */
export function capacitySnapshot(): { totalVramMiB: number | null; decision: LocalCapacityDecision } {
  let vramMiB: number | null = null
  try {
    vramMiB = deps.readVramMiB()
  } catch {
    // 读硬件失败 ⇒ 当"采不到"处理，退回今天的行为（不套槽），
    // 而不是让一次采集异常把整条推理链路拒掉
    vramMiB = null
  }
  // 测试缝（decisionOverride）只替换决策，**总量仍然如实报**——否则判据屏会出现"总量采不到但判据是实测档"这种自相矛盾
  if (decisionOverride) return { totalVramMiB: vramMiB, decision: decisionOverride() }
  // numCtxSetByApp 恒 false：全仓没有一处设置过 num_ctx（V-0 的实测边界正挂在这上面）
  return { totalVramMiB: vramMiB, decision: planLocalCapacity({ totalVramMiB: vramMiB, numCtxSetByApp: false }) }
}

export function slotDecision(): LocalCapacityDecision {
  return capacitySnapshot().decision
}

export function setSlotPromoteMsForTest(ms: number): void {
  promoteMs = ms
}

export function setSlotClockForTest(fn: (() => number) | null): void {
  nowFn = fn ?? Date.now
}

export function resetLocalSlotsForTest(): void {
  queues.clear()
  deps = { readVramMiB: () => null }
  decisionOverride = null
  setSlotPromoteMsForTest(BACKGROUND_PROMOTE_MS)
  setSlotClockForTest(null)
}

/** 只有回环地址才是"本机那张卡"；云 provider 一律不排队（行为不变） */
export function isLocalInferenceBaseUrl(baseUrl: string): boolean {
  return isLoopbackHost(urlHost(baseUrl))
}

/** 未实测档不套槽（用户 2026-10-15 选定）：判据说"这台没测过" ⇒ 直接放行 */
export function shouldQueueLocal(decision: LocalCapacityDecision): boolean {
  return decision.measured
}

export interface SlotRequest {
  baseUrl: string
  lane: SlotLane
  /** 进 perf detail 的标签，带模型名（此前 kb.* 标签不带 provider/model，跨模型时看不出谁慢） */
  label: string
  /** 调用方的取消信号：排队期间点「停止」要能退出队列，而不是几十秒后才起跑 */
  signal?: AbortSignal
  /**
   * §246：**排到槽、请求真要发出去的那一刻**回调一次。
   * 存在的理由不是方便，是探针需要一个"排队已经结束"的事实——它要给用户一个超时，
   * 而超时只能计在**请求在飞的那一段**：本地那张卡正被别的生成占着时，排队是本来的设计（M5／M6），
   * 把排队也算成"这台模型不回话"就是把用户误导成另一件事。
   */
  onStart?: () => void
}

/**
 * 闸门本体。返回值与异常完全透传——它不参与业务语义，只管什么时候把请求放出去。
 * 非回环 / 拿不到判据 / 未实测档 ⇒ 一行时序都不改。
 */
export async function withLocalSlot<T>(req: SlotRequest, fn: () => Promise<T>): Promise<T> {
  // §246：四条"根本不排队"的路也要报一声——回调的语义是"请求现在开始发"，不是"排到槽了"。
  // 漏掉任何一条，调用方的超时在那条路上就永远不会武装（比不排队更糟：它会永远挂着）。
  const start = (): Promise<T> => {
    req.onStart?.()
    return fn()
  }
  if (!isLocalInferenceBaseUrl(req.baseUrl)) return start()
  if (heldStore.getStore()) return start() // 重入：外层已持有槽，内层不再排队
  const decision = slotDecision()
  if (!shouldQueueLocal(decision)) return start()
  // 判据允许重叠时 embedding 不占对话槽。今天没有任何实测档给 true；
  // 留这一条是为了"将来放宽只改判据表，不用改闸门"（见方案 §4 V-2 的第二台机器）
  if (req.lane === 'embedding' && decision.allowChatEmbedOverlap) return start()

  const origin = originOf(req.baseUrl)
  const queue = queueFor(origin, decision.maxConcurrentChatSlots)
  const startedAt = nowFn()
  await queue.acquire(currentSlotKind(), req.signal)
  const waited = nowFn() - startedAt
  if (waited >= SLOW_WAIT_PERF_MS) {
    deps.recordWait?.(waited, `${req.lane}/${currentSlotKind()} model=${req.label} origin=${origin}`)
  }
  try {
    return await heldStore.run(true, () => {
      req.onStart?.()
      return fn()
    })
  } finally {
    queue.release()
  }
}

/** 观察用（测试与将来的判据屏读这个，不去猜内部状态） */
export function localSlotSnapshot(): { origin: string; busy: number; waiting: number; capacity: number }[] {
  return [...queues.entries()].map(([origin, q]) => ({
    origin,
    busy: q.busyCount,
    waiting: q.waitingCount,
    capacity: q.capacity
  }))
}
