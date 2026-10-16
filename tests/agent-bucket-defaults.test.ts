// 显存档 → 默认参数表（V4-Iter-147，B83 的 CI 半边）
//
// 这个文件守的是"表的形状"，不是"表里的数字对不对"：
//  · **只有实测档（entry-4g）能改值**，其余三档 + 采不到必须逐字等于全局默认——
//    140 立的口径在这儿只有一句话：没测过的档不许发明结论，放宽会撒谎，凭空收紧也会。
//  · 上限的收紧理由是**实测耗时**（M7 热态单次委派 1.34s、M8 被顶出后一次冷启动 3045ms、
//    M6 跨模型并发 7597ms vs 串行 8283ms 只差噪声），**不是**"显存放不下三个角色"——
//    后者早就被 M3 证伪（ctx≤2048 时 3b + coder-1.5b 同驻 3149MiB）。
//    ⇒ 下面那条"低配档不得出现跨模型角色"的反向对照，注释里必须写 M10 的混跑驱逐；
//      谁把它改成"因为放不下"，这条用例的守备就静默失效了。
//  · 分档数值与 `steward/model-recommend.ts` 的 ≥6/≥12/≥24 巧合相同但语义不同（那边管"拉哪个模型"，
//    这边管"一次编排开多大"），所以两表不许互相 import，本文件也不拿那边的结论给自己背书。
import { describe, it, expect } from 'vitest'
import {
  BUCKETS,
  GLOBAL_DELEGATION_LIMITS,
  capacityBucketOf,
  delegationLimitsOf,
  mayAssignDistinctModelRole,
  planLocalCapacity,
  type CapacityBucket
} from '../src/main/agent/local-capacity'

/** 把表投影成"一行一档"的形状：对号要能对整张表对，而不是对五个各写一遍的断言 */
const table = () =>
  Object.fromEntries(
    Object.entries(BUCKETS).map(([k, r]) => [k, { measured: r.measured, ...r.limits }])
  ) as Record<CapacityBucket, { measured: boolean } & { maxChildren: number; maxLlmCalls: number }>

describe('capacityBucketOf —— 认档只看总量，不做任何算术', () => {
  it('四档边界逐一对号（含"恰好等于阈值"落在哪一档）', () => {
    expect(capacityBucketOf(4096)).toBe('entry-4g')
    expect(capacityBucketOf(4097)).toBe('main-6g')
    expect(capacityBucketOf(12287)).toBe('main-6g')
    expect(capacityBucketOf(12288)).toBe('high-12g')
    expect(capacityBucketOf(24575)).toBe('high-12g')
    expect(capacityBucketOf(24576)).toBe('flagship-24g')
  })

  it('采不到 / 脏值 ⇒ unknown（不是 entry-4g，也不许被当成"巨大的卡"）', () => {
    for (const total of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '4096' as unknown as number]) {
      expect(capacityBucketOf(total)).toBe('unknown')
    }
  })

  it('判据里的 bucket 与 capacityBucketOf 同源（界面不许自己比数值）', () => {
    for (const total of [1024, 4096, 6144, 12288, 32768, null]) {
      expect(planLocalCapacity({ totalVramMiB: total }).bucket).toBe(capacityBucketOf(total))
    }
  })

  it('只有 entry-4g 那一档 measured=true（档名与"有没有实测"是两件事，必须各说各的）', () => {
    expect(planLocalCapacity({ totalVramMiB: 4096 }).measured).toBe(true)
    for (const total of [6144, 12288, 32768, null]) {
      expect(planLocalCapacity({ totalVramMiB: total }).measured).toBe(false)
    }
  })
})

describe('档位 → 编排上限：逐项对号', () => {
  it('表里五行逐字写明（改了任何一行都要在这里同步，不许让读代码的人去猜）', () => {
    expect(table()).toEqual({
      'entry-4g': { measured: true, maxChildren: 2, maxLlmCalls: 10 },
      'main-6g': { measured: false, maxChildren: 3, maxLlmCalls: 15 },
      'high-12g': { measured: false, maxChildren: 3, maxLlmCalls: 15 },
      'flagship-24g': { measured: false, maxChildren: 3, maxLlmCalls: 15 },
      unknown: { measured: false, maxChildren: 3, maxLlmCalls: 15 }
    })
  })

  it('只有实测档改了值；其余四行**逐字等于**全局默认（没测过 ⇒ 不发明结论）', () => {
    for (const bucket of ['main-6g', 'high-12g', 'flagship-24g', 'unknown'] as const) {
      expect(delegationLimitsOf(bucket, true)).toEqual(GLOBAL_DELEGATION_LIMITS)
    }
    expect(delegationLimitsOf('entry-4g', true)).not.toEqual(GLOBAL_DELEGATION_LIMITS)
    expect(delegationLimitsOf('entry-4g', true)).toEqual({ maxChildren: 2, maxLlmCalls: 10 })
  })

  it('父在云端时**任何档**都给全局默认：本机显存档管不着云端编排的长度', () => {
    for (const bucket of ['entry-4g', 'main-6g', 'high-12g', 'flagship-24g', 'unknown'] as const) {
      expect(delegationLimitsOf(bucket, false)).toEqual(GLOBAL_DELEGATION_LIMITS)
    }
  })

  it('全局默认就是 144/145 一直在用的那两个常量（改了常量必须同时改表，不许两份口径）', () => {
    expect(GLOBAL_DELEGATION_LIMITS).toEqual({ maxChildren: 3, maxLlmCalls: 15 })
  })
})

describe('反向对照：低配档不得出现跨模型角色', () => {
  // 拦它的理由是 **M10 的 chat×embed 混跑驱逐**（一 embed 进来把对话模型顶出去，随后一步付 3045ms 冷启动），
  // **不是**"显存放不下两个模型"——M3 实测 ctx≤2048 时 3b + coder-1.5b 确实同驻（3149MiB）。
  // 所以这条闸门永远不该被"算算字节够不够"放宽。
  it('entry-4g（应用从不设 num_ctx）⇒ 本地落点一律不放行', () => {
    const d = planLocalCapacity({ totalVramMiB: 4096 })
    const v = mayAssignDistinctModelRole(d, {
      childEndpointLocal: true,
      childUsesRetrieval: false,
      retrievalHitsLocalEndpoint: false
    })
    expect(v.allowed).toBe(false)
    expect(v.reasons).toContain('distinct-roles-not-measured')
  })

  it('同一份容量判据在 2GiB / 8GiB / 24GiB 上给出同样的"不放行"（档变大不等于测过）', () => {
    for (const total of [2048, 8192, 24576]) {
      const v = mayAssignDistinctModelRole(planLocalCapacity({ totalVramMiB: total }), {
        childEndpointLocal: true,
        childUsesRetrieval: false,
        retrievalHitsLocalEndpoint: false
      })
      expect(v.allowed).toBe(false)
    }
  })

  it('但"低配档"不等于"一律关"：子落云端时仍按 150 的口径放行（这条判据说的是本机显存）', () => {
    const v = mayAssignDistinctModelRole(planLocalCapacity({ totalVramMiB: 4096 }), {
      childEndpointLocal: false,
      childUsesRetrieval: false,
      retrievalHitsLocalEndpoint: false
    })
    expect(v.allowed).toBe(true)
  })
})
