// V4-Iter-140 容量判据：只许查实测表，不许做显存算术
//
// 两条反向对照是本文件的重点（B72 的两半）：
// ① "权重合计放得下"不得被当成可同驻 —— V-0 实测 3b + bge-m3 合计 2.7GiB < 4GiB 仍互相顶出；
// ② `/api/ps` 报的驻留条数不得被当成显存真相 —— 同一台机器上 ps 曾报三个同驻（合计恰等于总量），
//    而真生成时后者把前者顶掉。
// 两条都靠"输入里根本没有这些字段"来守：所以还要钉住**同档内不同总量给出同一决策**，
// 否则将来有人补一条 `total - weights > 0` 的"顺手优化"，本文件必须转红。
import { describe, it, expect } from 'vitest'
import { largestCudaVramMiB, planLocalCapacity } from '../src/main/agent/local-capacity'

describe('planLocalCapacity —— 实测档（≤4GiB，本机唯一测过的一档）', () => {
  it('4096MiB：并发槽 1、embed 不与对话并行、未设 ctx 时不给跨模型角色', () => {
    const d = planLocalCapacity({ totalVramMiB: 4096 })
    expect(d.measured).toBe(true)
    expect(d.maxConcurrentChatSlots).toBe(1)
    expect(d.allowChatEmbedOverlap).toBe(false)
    expect(d.rolesMayUseDistinctModels).toBe(false)
    expect(d.reasons).toContain('measured-bucket')
    expect(d.reasons).toContain('chat-embed-exclusive')
    expect(d.reasons).toContain('distinct-models-need-small-ctx')
  })

  it('反向对照②：应用显式设了小 ctx ⇒ 只放开跨模型角色，embed 仍然互斥', () => {
    const d = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    expect(d.rolesMayUseDistinctModels).toBe(true)
    expect(d.allowChatEmbedOverlap).toBe(false)
    expect(d.maxConcurrentChatSlots).toBe(1)
    expect(d.reasons).not.toContain('distinct-models-need-small-ctx')
  })

  it('同档内不同总量给出同一决策（钉住"不许按字节做算术"）', () => {
    const base = planLocalCapacity({ totalVramMiB: 4096 })
    for (const total of [1024, 2048, 3072, 4095]) {
      expect(planLocalCapacity({ totalVramMiB: total })).toEqual(base)
    }
  })

  it('并发槽不随显存增长（M6：并发不比串行快，实测差 686ms 属噪声）', () => {
    for (const total of [512, 2048, 4096]) {
      expect(planLocalCapacity({ totalVramMiB: total }).maxConcurrentChatSlots).toBe(1)
    }
  })
})

describe('planLocalCapacity —— 没有实测数据的档一律保守', () => {
  it('大于 4GiB 的每张卡都标 no-measurement-for-bucket，且不因"显存多"放宽', () => {
    for (const total of [4097, 6144, 12288, 24576]) {
      const d = planLocalCapacity({ totalVramMiB: total })
      expect(d.measured).toBe(false)
      expect(d.allowChatEmbedOverlap).toBe(false)
      expect(d.rolesMayUseDistinctModels).toBe(false)
      expect(d.maxConcurrentChatSlots).toBe(1)
      expect(d.reasons).toContain('no-measurement-for-bucket')
    }
  })

  it('设了 ctx 也不许在大档放行跨模型角色（那条实测只在 4GiB 机上做过）', () => {
    const d = planLocalCapacity({ totalVramMiB: 12288, numCtxSetByApp: true })
    expect(d.rolesMayUseDistinctModels).toBe(false)
  })

  it('采不到总显存（Mac / 无 nvidia-smi / 无独显）⇒ vram-unknown 保守档', () => {
    for (const total of [null, 0, -1, Number.NaN]) {
      const d = planLocalCapacity({ totalVramMiB: total })
      expect(d.measured).toBe(false)
      expect(d.maxConcurrentChatSlots).toBe(1)
      expect(d.allowChatEmbedOverlap).toBe(false)
      expect(d.reasons).toContain('vram-unknown')
    }
  })

  it('Infinity 与字符串脏值不被当成"巨大的卡"', () => {
    expect(planLocalCapacity({ totalVramMiB: Infinity as unknown as number }).reasons).toContain('vram-unknown')
    expect(planLocalCapacity({ totalVramMiB: '4096' as unknown as number }).reasons).toContain('vram-unknown')
  })
})

describe('planLocalCapacity —— 判据形状本身', () => {
  it('反向对照①+②：多塞进来的"权重体积"和"ps 驻留条数"不得影响决策', () => {
    // 今天这两个字段根本不进 LocalCapacityInput（TS 层就挡着）。这里用 as any 强行塞，
    // 是为了给"将来有人把它们接上并据此放宽"留一条会转红的断言 ——
    // 依据是 V-0：3b + bge-m3 权重合计 2.7GiB < 4GiB 仍被逐（①），
    // 而 ps 曾报三个同驻、合计恰等于显存总量，真生成时却互相顶出（②）。
    const base = planLocalCapacity({ totalVramMiB: 4096 })
    const polluted = planLocalCapacity({
      totalVramMiB: 4096,
      weightsMiB: 2674,
      psResidentCount: 3
    } as unknown as Parameters<typeof planLocalCapacity>[0])
    expect(polluted).toEqual(base)
    expect(polluted.allowChatEmbedOverlap).toBe(false)
  })

  it('reasons 去重且不为空', () => {
    const d = planLocalCapacity({ totalVramMiB: 4096 })
    expect(d.reasons.length).toBeGreaterThan(0)
    expect(new Set(d.reasons).size).toBe(d.reasons.length)
  })
})

describe('largestCudaVramMiB —— bytes→MiB 的换算（写混就静默翻档，V-0 的实测边界正挂在这上面）', () => {
  it('本机真实值：4293918720 bytes ⇒ 4095MiB（仍属实测档）', () => {
    expect(largestCudaVramMiB([{ cuda: true, memory: 4293918720 }])).toBe(4095)
  })

  it('整 4GiB ⇒ 4096；12GiB ⇒ 12288（跨档边界）', () => {
    expect(largestCudaVramMiB([{ cuda: true, memory: 4096 * 1048576 }])).toBe(4096)
    expect(largestCudaVramMiB([{ cuda: true, memory: 12288 * 1048576 }])).toBe(12288)
  })

  it('多卡取最大的一块，核显与脏值不参与', () => {
    expect(
      largestCudaVramMiB([
        { cuda: false, memory: 2147483648 },
        { cuda: true, memory: 4294967296 },
        { cuda: true, memory: 17179869184 },
        { cuda: true }
      ])
    ).toBe(16384)
  })

  it('没有 cuda / 全是脏值 ⇒ null（不是 0，判据据此走"采不到"分支）', () => {
    for (const gpus of [[], [{ cuda: false, memory: 100 }], [{ cuda: true, memory: 0 }], [{ cuda: true, memory: -1 }], [{ cuda: true, memory: Number.NaN }], [{ cuda: true, memory: '4096' as unknown as number }]]) {
      expect(largestCudaVramMiB(gpus)).toBeNull()
    }
  })

  it('换算结果直接喂判据：4GiB 是实测档，8GiB 是未实测档', () => {
    expect(planLocalCapacity({ totalVramMiB: largestCudaVramMiB([{ cuda: true, memory: 4 * 1073741824 }])!, numCtxSetByApp: false }).measured).toBe(true)
    expect(planLocalCapacity({ totalVramMiB: largestCudaVramMiB([{ cuda: true, memory: 8 * 1073741824 }])!, numCtxSetByApp: false }).measured).toBe(false)
  })
})
