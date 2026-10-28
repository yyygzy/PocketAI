// @vitest-environment jsdom
// V4-Iter-344：设置页那一整块加密态的同步器（SettingsModule 的三发读共用）
//
// 缺陷形状＝§342 的姊妹处：一份主进程状态在渲染层留着当面板数据，而它有**三个**读者
// （挂载首发、锁屏事件重读、面板动作后 refreshEnc）。三个读者各写各的，谁先落地没有保证——
// 「关掉加密」的写点就在面板动作里，若锁屏事件那一发（改前的旧值）迟到了，
// 面板会被画回「已加密＋已解锁」，那一格上还会给出改口令／关闭加密两颗键。
//
// 四条判据：
// ① 读成功 ⇒ 整块状态写回，并把「读不到」那句收回；
// ② 读失败（信封 {ok:false}）⇒ 只报错、**不动旧值**（读不到不等于"没加密"，§343 的口径）；
// ③ 通道抛出（preload 侧真会 reject 的那条路：渲染进程刚断、窗口正在关）⇒ 同样只报错；
// ④ 迟到对照 ⇒ 先出发后回来的那一发不许顶掉新读数。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { stubPocketai } from './helpers/renderer'
import { createEncryptionStatusSyncer } from '../src/renderer/src/utils/lock-flags'

const t = (k: string): string => `t:${k}`

const DB = { dbEncrypted: true, unlocked: true, mode: 'db' }
const NONE = { dbEncrypted: false, unlocked: false, mode: 'none' }

describe('createEncryptionStatusSyncer', () => {
  let setStatus: ReturnType<typeof vi.fn>
  let setErr: ReturnType<typeof vi.fn>
  let deps: { setStatus: any; setErr: any; t: typeof t }

  beforeEach(() => {
    setStatus = vi.fn()
    setErr = vi.fn()
    deps = { setStatus, setErr, t }
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('① 读成功：整块写回并收回「读不到」', async () => {
    stubPocketai({ getEncryptionStatus: () => DB })
    await createEncryptionStatusSyncer(deps)()
    expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({ dbEncrypted: true }))
    expect(setErr).toHaveBeenCalledWith(null)
  })

  it('② 读失败（信封）：只报错，旧的那一块一个字都不许被刷掉', async () => {
    stubPocketai({ getEncryptionStatus: () => ({ ok: false, error: 'boom' }) })
    await createEncryptionStatusSyncer(deps)()
    expect(setErr).toHaveBeenCalledWith('boom')
    expect(setStatus, '失败侧写值＝面板按一次没读成的结果重画').not.toHaveBeenCalled()
  })

  it('③ 通道抛出：也走「只报错」这一侧，不冒未捕获拒绝', async () => {
    stubPocketai({
      getEncryptionStatus: () => {
        throw new Error('ipc down')
      }
    })
    await expect(createEncryptionStatusSyncer(deps)()).resolves.toBeUndefined()
    expect(setErr).toHaveBeenCalledWith('ipc down')
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('④ 迟到对照：先出发后回来的那一发不许顶掉新读数', async () => {
    const resolvers: Array<(v: unknown) => void> = []
    stubPocketai({
      getEncryptionStatus: () => new Promise((resolve) => { resolvers.push(resolve) })
    })
    const sync = createEncryptionStatusSyncer(deps)
    // 第一发＝锁屏事件重读（会带回改前的旧值），第二发＝用户刚点完「关闭加密」后的刷新
    const first = sync()
    const second = sync()
    const secondResolve = resolvers[1]!
    secondResolve(NONE)
    await second
    expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ dbEncrypted: false }))
    const firstResolve = resolvers[0]!
    firstResolve(DB)
    await first
    expect(setStatus, '旧那一发不许再写回').not.toHaveBeenCalledWith(expect.objectContaining({ dbEncrypted: true }))
    expect(setStatus).toHaveBeenCalledTimes(1)
  })

  it('反向对照：一发读完再读下一发时两发都该写回（守卫不是"只认第一发"）', async () => {
    const resolvers: Array<(v: unknown) => void> = []
    stubPocketai({
      getEncryptionStatus: () => new Promise((resolve) => { resolvers.push(resolve) })
    })
    const sync = createEncryptionStatusSyncer(deps)
    const first = sync()
    resolvers[0]!(DB)
    await first
    const second = sync()
    resolvers[1]!(NONE)
    await second
    expect(setStatus).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenLastCalledWith(expect.objectContaining({ dbEncrypted: false }))
  })
})
