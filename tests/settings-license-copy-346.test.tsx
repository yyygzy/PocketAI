// @vitest-environment jsdom
// V4-Iter-346：许可证那份副本（useLicenseCopy）真的两发共用同一个代次计数器
//
// 分工与 §344 同轴：源码级闸门（lock-flags-gate-342 的 ⑤ 面）钉"裸读名单只剩同步器本体一处"
// 「工厂只造一次」「两侧判代次」，但钉不住**同步器是不是每次 render 都重建**——
// 每帧现造的话，挂载那一发在它自己那份计数器里永远是"最新"，迟到了照样写回。
// ⑤ 就是专门演这一档的：挂载那发出自第一次 render，refresh 取自重渲染之后的闭包。
//
// 这一族的并发不是想象出来的：面板那三颗激活键的 `disabled={busy}` 只挡"动作本身在飞"，
// 而 `onChange()`（＝refresh）在 try 里不被 await、`finally` 立刻放开键
// ⇒ 读数在飞时键已能再点，而屏上的许可证还是**动作前那份**。所以这里的两份读数带着**不同的 plan**，
// 迟到那一发若被写回，屏上就是"已被覆盖的那份授权"（到期日与持有人都跟着错）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { HookProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { useLicenseCopy } from '../src/renderer/src/modules/settings/SettingsModule'
import type { LicenseStatus } from '../src/shared/types'

const lic = (plan: string, owner: string): LicenseStatus =>
  ({
    valid: true,
    payload: { owner, plan, expires_at: Date.parse('2027-01-01T00:00:00Z'), features: [] }
  }) as unknown as LicenseStatus

const PRO = lic('pro', '墨匣用户甲')
const TEAM = lic('team', '墨匣用户乙')

let resolvers: Array<(v: unknown) => void>

beforeEach(() => {
  resolvers = []
  stubPocketai({
    // 每发都挂在 Promise 上，由用例决定谁先落地——乱序是这条缺陷的唯一入口
    getLicenseStatus: () => new Promise((resolve) => { resolvers.push(resolve) })
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

describe('useLicenseCopy', () => {
  it('① 正向对照：挂载那一发读回来就写进副本', async () => {
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    expect(resolvers.length, '挂载必须读一发').toBe(1)
    await settle(0, PRO)
    await waitFor(() => expect(result.current.lic).toEqual(expect.objectContaining({ valid: true })))
    expect(result.current.err, '读到了就不许留着上一次的原因').toBeNull()
  })

  it('② 信封失败：原因写上、旧值一个字都不动（读不到不等于"没授权"）', async () => {
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    await settle(0, PRO)
    await act(async () => {
      result.current.refresh()
    })
    await settle(1, { ok: false, error: '许可证通道没接上' })
    expect(result.current.err).toBe('许可证通道没接上')
    expect(result.current.lic, '失败侧刷副本＝把"已授权"那一屏瞬间抹成未授权').toEqual(
      expect.objectContaining({ valid: true })
    )
  })

  it('③ reject 面（桥层抛出）同样只报原因、不动旧值', async () => {
    stubPocketai({
      getLicenseStatus: () => Promise.reject(new Error('通道被占用'))
    })
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    await waitFor(() => expect(result.current.err).toBe('通道被占用'))
    expect(result.current.lic, '一发都没成功过时也不该凭空写出一份数据').toBeNull()
    expect(pocketaiCalls().filter((c) => c.fn === 'getLicenseStatus').length).toBe(1)
  })

  it('④ 迟到对照：后发那发先落地、挂载那发迟到了 ⇒ 迟的不许写回', async () => {
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    await act(async () => {
      result.current.refresh()
    })
    expect(resolvers.length, 'refresh 走的必须是同一份同步器').toBe(2)
    await settle(1, TEAM)
    expect(result.current.lic).toEqual(expect.objectContaining({ payload: expect.objectContaining({ plan: 'team' }) }))
    await settle(0, PRO)
    expect(result.current.lic, '旧读数顶掉新读数＝屏上画回已被覆盖的那份授权').toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ plan: 'team' }) })
    )
  })

  // 这条盯"同步器是不是每次 render 都重建"：挂载那发是第一次 render 的那份，
  // refresh 取的是重渲染之后那份闭包——若每帧现造，两者各有一个 gen=0 的计数器，④ 也照样演不出来
  // （④ 两发都出自同一次 render 的闭包，每帧重造的写法在④ 里恰好仍是对的）。
  it('⑤ 重渲染之后才按的 refresh：挂载那发迟到了仍要被丢掉', async () => {
    const { result, rerender } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    rerender()
    await act(async () => {
      result.current.refresh()
    })
    expect(resolvers.length).toBe(2)
    await settle(1, TEAM)
    await settle(0, PRO)
    expect(result.current.lic, '每帧重造同步器＝挂载那一发在它自己那份里是最新的，迟到了也写回').toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ plan: 'team' }) })
    )
  })

  it('⑥ 连点两下重试：赢的是**最后发出的那一发**，不是最后到货的那一发', async () => {
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    await act(async () => {
      result.current.refresh()
      result.current.refresh()
    })
    expect(resolvers.length, '两下就是两发（同一次 render 里连按也各有归属）').toBe(3)
    await settle(2, PRO)
    expect(result.current.lic, '第三发（最后一次请求）到货就该上屏').toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ plan: 'pro' }) })
    )
    await settle(1, TEAM)
    await settle(0, lic('free', '墨匣用户丙'))
    // 守卫判的是"我这次请求还是不是最新的"，不是"我是不是最后一个到的"：
    // 早发的那两发即使最后才回来，也不许把最新那次请求的结果顶掉
    expect(result.current.lic, '迟到的旧请求回头顶掉新请求＝屏上画回已被覆盖的那份授权').toEqual(
      expect.objectContaining({ payload: expect.objectContaining({ plan: 'pro' }) })
    )
  })

  it('⑦ 这一族的读者只有这个 hook：整个用例过程里 getLicenseStatus 一发不多', async () => {
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    await settle(0, PRO)
    await act(async () => {
      result.current.refresh()
    })
    await settle(1, TEAM)
    expect(pocketaiCalls().filter((c) => c.fn === 'getLicenseStatus').length, '多出来的那发就是又一个没有守卫的读者').toBe(2)
  })

  it('⑧ 失败之后再来一发成功：那句「刷新失败」当场收回（§345 那张脸不能挂在已刷新的数据上）', async () => {
    const { result } = renderHook(() => useLicenseCopy(), { wrapper: HookProviders })
    await settle(0, PRO)
    await act(async () => {
      result.current.refresh()
    })
    await settle(1, { ok: false, error: '许可证通道没接上' })
    expect(result.current.err).toBe('许可证通道没接上')
    await act(async () => {
      result.current.refresh()
    })
    await settle(2, TEAM)
    await waitFor(() => expect(result.current.err).toBeNull())
    expect(result.current.lic).toEqual(expect.objectContaining({ payload: expect.objectContaining({ plan: 'team' }) }))
  })
})
