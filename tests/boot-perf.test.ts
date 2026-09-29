// boot-perf 启动埋点测试
//
// 覆盖 src/main/steward/boot-perf.ts：
// - bootMark：按调用顺序追加阶段、累计 ms 非递减、日志调用不抛错
// - getBootPerf：返回只读副本（外部修改不影响内部状态）+ totalMs 取最后阶段
import { describe, it, expect, vi } from 'vitest'

// mock logger（electron 依赖链，埋点测试不关心日志输出）
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })
}))

import { bootMark, getBootPerf, type BootStageMark } from '../src/main/steward/boot-perf'

describe('bootMark + getBootPerf', () => {
  it('按调用顺序追加阶段，累计 ms 非递减', () => {
    bootMark('dirs', '目录/日志初始化')
    bootMark('db', 'DB 打开')
    bootMark('window', '主窗口已创建')

    const { stages, totalMs } = getBootPerf()
    expect(stages.length).toBeGreaterThanOrEqual(3)
    const last3 = stages.slice(-3).map((s: BootStageMark) => s.id)
    expect(last3).toEqual(['dirs', 'db', 'window'])
    for (let i = 1; i < stages.length; i++) {
      expect(stages[i]!.ms).toBeGreaterThanOrEqual(stages[i - 1]!.ms)
      expect(stages[i]!.ms).toBeGreaterThanOrEqual(0)
    }
    expect(totalMs).toBe(stages[stages.length - 1]!.ms)
  })

  it('getBootPerf 返回只读副本，外部修改不影响内部状态', () => {
    const before = getBootPerf().stages.map((s) => ({ ...s }))
    const snap = getBootPerf()
    snap.stages.push({ id: 'dirs', ms: 99999 })
    if (snap.stages[0]) snap.stages[0].ms = 0

    expect(getBootPerf().stages).toEqual(before)
  })

  it('totalMs 等于最后一个阶段的累计毫秒', () => {
    bootMark('schedulers', '调度器启动完成')
    const { stages, totalMs } = getBootPerf()
    expect(totalMs).toBe(stages[stages.length - 1]!.ms)
  })
})
