// @vitest-environment jsdom
// V4-Iter-344：设置页那份加密态副本（useEncryptionCopy）真的三发共用同一个代次计数器
//
// 为什么还要挂一层真 hook：源码级闸门能钉「三处都调 syncEnc()」「文件里一处裸读都不许留」，
// 但钉不住**同步器是不是每次 render 都重建**——写成 `const syncEnc = createEncryptionStatusSyncer(…)`
// 直接放在函数体里，三发照样各调一次、裸读也是 0，可每换一个计数器就归零，守卫立刻没牙
// （纪律第 30 条：接线能真注册＋真 invoke 就别只留源码判据）。
// 分工：③④ 钉"迟到丢掉／重渲染不多发"，⑥ 才是"每帧重造"那档的判据——
// 它让挂载那一发出自第一次 render、refresh 那一发出自重渲染之后，两发若各拿自己的计数器就挡不住迟到的。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { HookProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { useEncryptionCopy } from '../src/renderer/src/modules/settings/SettingsModule'

const DB = { mode: 'db', dbEncrypted: true, unlocked: true, masterPasswordVerified: true }
const NONE = { mode: 'none', dbEncrypted: false, unlocked: false, masterPasswordVerified: false }

let resolvers: Array<(v: unknown) => void>
let lockCbs: Array<(e: unknown) => void>
let offLock: ReturnType<typeof vi.fn>

beforeEach(() => {
  resolvers = []
  lockCbs = []
  offLock = vi.fn()
  stubPocketai({
    // 每发都挂在Promise 上，由用例决定谁先落地——乱序是这条缺陷的唯一入口
    getEncryptionStatus: () => new Promise((resolve) => { resolvers.push(resolve) }),
    onLockStateChange: (cb: (e: unknown) => void) => {
      lockCbs.push(cb)
      return offLock
    }
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** 把第 n 发读数放出去并让 React 处理完这次落值 */
async function settle(n: number, value: unknown): Promise<void> {
  await act(async () => {
    resolvers[n]!(value)
    await Promise.resolve()
  })
}

describe('useEncryptionCopy', () => {
  it('① 正向对照：挂载那一发读回来就写进副本（屏上"未加密"不是判据，值本身才是）', async () => {
    const { result } = renderHook(() => useEncryptionCopy(), { wrapper: HookProviders })
    expect(resolvers.length, '挂载必须读一发').toBe(1)
    await settle(0, DB)
    await waitFor(() => expect(result.current.enc).toEqual(expect.objectContaining({ dbEncrypted: true })))
  })

  it('② 锁屏事件到达时再发一发，卸载时把订阅摘掉', async () => {
    const { result, unmount } = renderHook(() => useEncryptionCopy(), { wrapper: HookProviders })
    await settle(0, DB)
    expect(result.current.enc).toEqual(expect.objectContaining({ dbEncrypted: true }))
    await act(async () => {
      lockCbs[0]!({ state: 'locked' })
    })
    expect(resolvers.length, '锁屏事件到达必须重读（§342 同口径）').toBe(2)
    expect(offLock, '没有卸载函数被调用＝监听器留尾').not.toHaveBeenCalled()
    unmount()
    expect(offLock).toHaveBeenCalledTimes(1)
  })

  it('③ 迟到对照：锁屏那一发先落地、挂载那一发迟到了 ⇒ 迟的那发不许写回', async () => {
    const { result } = renderHook(() => useEncryptionCopy(), { wrapper: HookProviders })
    await act(async () => {
      lockCbs[0]!({ state: 'unlocked' })
    })
    // 第二发（锁屏后重读，已经是明文）先回来
    await settle(1, NONE)
    expect(result.current.enc).toEqual(expect.objectContaining({ dbEncrypted: false }))
    // 第一发（挂载那次、还是改前的值）现在才回来
    await settle(0, DB)
    expect(result.current.enc, '旧读数顶掉新读数＝面板画回"已加密"，那格上还挂着关闭加密那颗键').toEqual(
      expect.objectContaining({ dbEncrypted: false })
    )
  })

  it('④ 中间夹两次重渲染：读不发多、订阅不重挂（重挂载一次就多发一发的写法在这里会红）', async () => {
    const { result, rerender } = renderHook(() => useEncryptionCopy(), { wrapper: HookProviders })
    await act(async () => {
      lockCbs[0]!({ state: 'unlocked' })
    })
    rerender()
    rerender()
    expect(resolvers.length).toBe(2)
    await settle(1, NONE)
    await settle(0, DB)
    expect(result.current.enc).toEqual(expect.objectContaining({ dbEncrypted: false }))
  })

  it('⑤ 面板动作后的 refresh() 也算一发：它读到的新值不许被在飞的旧读数顶掉', async () => {
    const { result } = renderHook(() => useEncryptionCopy(), { wrapper: HookProviders })
    await act(async () => {
      result.current.refresh()
    })
    expect(resolvers.length, 'refresh 走的必须是同一份同步器').toBe(2)
    await settle(1, NONE)
    await settle(0, DB)
    expect(result.current.enc).toEqual(expect.objectContaining({ dbEncrypted: false }))
    // 三发读都出自这个 hook（挂载＋refresh＋锁屏事件之外不该再有第四个读者）
    expect(pocketaiCalls().filter((c) => c.fn === 'getEncryptionStatus').length).toBe(2)
  })

  // 这条专门盯"同步器是不是每次 render 都重建"：挂载那一发是第一次 render 的那份，
  // refresh 取的是**重渲染之后**那份闭包——若每帧现造，两者各有一个 gen=0 的计数器，
  // 挂载那发在自己那份里就是"最新"，迟到了照样写回。④ 演不出这一档（那两条读都出自同一次 render 的闭包）。
  it('⑥ 重渲染之后才按的 refresh：挂载那发迟到了仍要被丢掉', async () => {
    const { result, rerender } = renderHook(() => useEncryptionCopy(), { wrapper: HookProviders })
    rerender()
    await act(async () => {
      result.current.refresh()
    })
    expect(resolvers.length).toBe(2)
    await settle(1, NONE)
    expect(result.current.enc).toEqual(expect.objectContaining({ dbEncrypted: false }))
    await settle(0, DB)
    expect(result.current.enc, '每帧重造同步器＝挂载那一发在它自己那份里是最新的，迟到了也写回').toEqual(
      expect.objectContaining({ dbEncrypted: false })
    )
  })
})
