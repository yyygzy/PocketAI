// perf-probe 运行期慢操作埋点测试
//
// 覆盖 src/main/steward/perf-probe.ts：
// - recordPerf：入环形缓冲 + ms 取整 + detail 透传
// - 环形缓冲上限 100，超出 FIFO 淘汰最旧
// - getRecentPerf 返回只读副本（外部修改不影响内部状态）
import { describe, it, expect, vi, beforeEach } from 'vitest'

// mock logger（electron 依赖链，埋点测试不关心日志输出）
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { recordPerf, getRecentPerf, clearPerfEvents } from '../src/main/steward/perf-probe'

beforeEach(() => {
  clearPerfEvents()
})

describe('recordPerf + getRecentPerf', () => {
  it('记录事件：label/ms 取整/detail/at', () => {
    recordPerf('kb.retrieve', 123.7, 'kbs=1')
    const list = getRecentPerf()
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ label: 'kb.retrieve', ms: 124, detail: 'kbs=1' })
    expect(typeof list[0]!.at).toBe('number')
  })

  it('环形缓冲上限 100，超出淘汰最旧', () => {
    for (let i = 0; i < 120; i++) recordPerf('op', i)
    const list = getRecentPerf()
    expect(list.length).toBe(100)
    // 最旧 20 条被淘汰，首条为 i=20
    expect(list[0]!.ms).toBe(20)
    expect(list[list.length - 1]!.ms).toBe(119)
  })

  it('getRecentPerf 返回只读副本，外部修改不影响内部状态', () => {
    recordPerf('a', 1)
    const snap = getRecentPerf()
    snap.push({ label: 'fake', ms: 0, at: 0 })
    if (snap[0]) snap[0].ms = 99999
    const again = getRecentPerf()
    expect(again.length).toBe(1)
    expect(again[0]).toMatchObject({ label: 'a', ms: 1 })
  })
})
