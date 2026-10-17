// 判据屏的行与文案码（V4-Iter-146 / B81）——纯函数 + 四语字典对号，不挂组件
//
// 这块屏的**全部风险都在措辞**上：判据取值来自 140 的实测表，而表外的一切都是保守默认。
// 把默认画成"测得"，用户就会以为放宽已经生效——所以用例钉的是"来源档"，不是数值好不好看。
// 另一条：动态拼 key（`judgement.reason.${code}`）是 i18n-parity 扫不到的死角（Iter-102 就是这么漏的），
// 所以这里逐码把四本字典都点一遍。
import { describe, it, expect } from 'vitest'
import {
  buildLocalJudgementRows,
  type JudgementRow,
  type LocalJudgementReport
} from '../src/shared/local-judgement'
import { planLocalCapacity, distinctRoleScope } from '../src/main/agent/local-capacity'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const DICTS: Array<[string, Record<string, string>]> = [['zh', zh], ['en', en], ['ja', ja], ['ko', ko]]

/**
 * 150：一行的角色事实 = 对**两种落点**各判一次（走 `distinctRoleScope`，与主进程同一个算法）。
 * 用例不许在这里手拼 scope——拼出来的话，"云子不受容量档管"这条口径就只在被测代码之外存在了。
 */
const roleVerdict = (
  assistantName: string,
  capacity: ReturnType<typeof planLocalCapacity>,
  facts: { childUsesRetrieval?: boolean; retrievalHitsLocalEndpoint?: boolean } = {}
) => {
  const childUsesRetrieval = facts.childUsesRetrieval ?? false
  const retrievalHitsLocalEndpoint = facts.retrievalHitsLocalEndpoint ?? false
  const { scope, reasons } = distinctRoleScope(capacity, { childUsesRetrieval, retrievalHitsLocalEndpoint })
  return { assistantName, childUsesRetrieval, retrievalHitsLocalEndpoint, scope, reasons }
}

const report = (over: Partial<LocalJudgementReport> = {}): LocalJudgementReport => ({
  collectedAt: 1_700_000_000_000,
  totalVramMiB: 4096,
  capacity: planLocalCapacity({ totalVramMiB: 4096 }),
  liveVram: { available: true, rows: [{ name: 'GTX 1050 Ti', totalMiB: 4096, usedMiB: 3149 }] },
  slots: [],
  roleVerdicts: [roleVerdict('不碰知识库的助手', planLocalCapacity({ totalVramMiB: 4096 }))],
  delegations: [],
  ...over
})

const row = (rows: JudgementRow[], id: string): JudgementRow => {
  const r = rows.find((x) => x.id === id)
  if (!r) throw new Error(`没有这一行：${id}（现有：${rows.map((x) => x.id).join(', ')}）`)
  return r
}

describe('来源档：不许把保守默认画成测得', () => {
  it('4GiB（本机实测档）⇒ 并行数与同驻两行都标 measured', () => {
    const rows = buildLocalJudgementRows(report())
    expect(row(rows, 'chat-slots').sourceCode).toBe('measured')
    expect(row(rows, 'chat-embed-overlap').sourceCode).toBe('measured')
  })

  it('12GiB（没有实测数据的档）⇒ 同样两行必须降级成 no-measurement，一行都不许留 measured', () => {
    const big = planLocalCapacity({ totalVramMiB: 12288 })
    const rows = buildLocalJudgementRows(
      report({ totalVramMiB: 12288, capacity: big })
    )
    expect(big.measured, '前提：这一档确实没实测数据').toBe(false)
    for (const id of ['chat-slots', 'chat-embed-overlap', 'distinct-roles:不碰知识库的助手']) {
      expect(row(rows, id).sourceCode, id).toBe('no-measurement')
    }
  })

  it('总显存采不到（Mac / 无 nvidia-smi）⇒ 总量行 unavailable，其余按保守默认', () => {
    const none = planLocalCapacity({ totalVramMiB: null })
    const rows = buildLocalJudgementRows(report({ totalVramMiB: null, capacity: none }))
    expect(row(rows, 'vram-total').sourceCode).toBe('unavailable')
    expect(row(rows, 'chat-slots').sourceCode).toBe('no-measurement')
  })
})

describe('现采显存：只作观察', () => {
  it('采到 ⇒ 标 measured **并且**带"不参与判据"的说明', () => {
    const rows = buildLocalJudgementRows(report())
    const live = row(rows, 'vram-used-live')
    expect(live.sourceCode).toBe('measured')
    expect(live.noteKey).toBe('judgement.note.not-a-capacity-input')
  })

  it('采不到 ⇒ 不许显示 0，也不许留说明（没读数可解释）', () => {
    const rows = buildLocalJudgementRows(report({ liveVram: { available: false, rows: [] } }))
    const live = row(rows, 'vram-used-live')
    expect(live.valueKey).toBe('judgement.value.unavailable')
    expect(live.sourceCode).toBe('unavailable')
    expect(live.noteKey, '采不到时那句"只作观察"是废话').toBeUndefined()
  })

  it('总量行注明"来自启动快照"——它和现采值不是同一时刻的数', () => {
    expect(row(buildLocalJudgementRows(report()), 'vram-total').noteKey).toBe('judgement.note.startup-snapshot')
  })
})

describe('跨模型角色的两条合取：哪一条没过就说什么（150 起按落点摊成三态）', () => {
  const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })

  it('①没过（应用从不设 num_ctx）+ 不碰检索 ⇒ 取值是 cloud-only（界面上那句 164 起写「只能跑在云端」），码仍是那两条', () => {
    const rows = buildLocalJudgementRows(report())
    const r = row(rows, 'distinct-roles:不碰知识库的助手')
    // 这一格是 150 的新事实：容量档没过**不再把整条路关死**——云子不占这张卡，判据对它没有对象
    expect(r.valueKey).toBe('judgement.value.distinctScope.cloud-only')
    const codes = r.reasonCodes
    expect(codes).toContain('distinct-roles-not-measured')
    expect(codes).toContain('distinct-models-need-small-ctx')
    // 角色判定自己带过的码，容量判定又补一句时**不许重复出现**（149 加了分隔符后重复会连着显示两遍）
    expect(new Set(codes).size, `码重复了：${codes.join(' / ')}`).toBe(codes.length)
    expect(r.noteKey, '不碰检索就不该有那条注').toBeUndefined()
  })

  it('角色判定里已经带着 small-ctx 时，合并后仍只有一条', () => {
    const rows = buildLocalJudgementRows(
      report({
        roleVerdicts: [
          {
            assistantName: '两条都写着的助手',
            childUsesRetrieval: false,
            retrievalHitsLocalEndpoint: false,
            scope: 'not-allowed' as const,
            reasons: ['distinct-roles-not-measured', 'distinct-models-need-small-ctx']
          }
        ]
      })
    )
    expect(row(rows, 'distinct-roles:两条都写着的助手').reasonCodes).toEqual([
      'distinct-roles-not-measured',
      'distinct-models-need-small-ctx'
    ])
  })

  it('①过了 + 检索链的 embedding 落本地端点 ⇒ 第二条单独否掉，注说的是"压进本机显存"', () => {
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [roleVerdict('绑了本地 embedding 库的助手', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: true })]
      })
    )
    const r = row(rows, 'distinct-roles:绑了本地 embedding 库的助手')
    expect(r.reasonCodes).toEqual(['retrieval-chain-exclusive'])
    expect(r.noteKey).toBe('judgement.note.retrieval-hits-local-embedding')
    expect(r.valueKey).toBe('judgement.value.distinctScope.none')
  })

  it('①过了 + 走检索链但 embedding **不落本地**（内置 CPU / 云端）⇒ 第二条不再拦', () => {
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [roleVerdict('用内置 CPU embedding 的助手', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: false })]
      })
    )
    const r = row(rows, 'distinct-roles:用内置 CPU embedding 的助手')
    expect(r.reasonCodes).toEqual(['distinct-roles-allowed'])
    // 注仍要说"这条编排会走向量检索"——那是事实，只是它不再是拦的理由
    expect(r.noteKey).toBe('judgement.note.retrieval-chain')
    expect(r.valueKey).toBe('judgement.value.distinctScope.any')
  })

  it('两条都过 ⇒ 取值"本地与云端落点都行"', () => {
    const rows = buildLocalJudgementRows(
      report({ capacity: smallCtx, roleVerdicts: [roleVerdict('不碰知识库的助手', smallCtx)] })
    )
    const r = row(rows, 'distinct-roles:不碰知识库的助手')
    expect(r.valueKey).toBe('judgement.value.distinctScope.any')
    expect(r.reasonCodes).toEqual(['distinct-roles-allowed'])
  })

  it('反向对照：①没过**且** embedding 落本地 ⇒ 两条码都在、取值退回"不允许"（细化没把该拦的放掉）', () => {
    const rows = buildLocalJudgementRows(
      report({ roleVerdicts: [roleVerdict('低配又碰本地 embedding', planLocalCapacity({ totalVramMiB: 4096 }), { childUsesRetrieval: true, retrievalHitsLocalEndpoint: true })] })
    )
    const r = row(rows, 'distinct-roles:低配又碰本地 embedding')
    expect(r.valueKey).toBe('judgement.value.distinctScope.none')
    expect(r.reasonCodes).toEqual(['distinct-roles-not-measured', 'retrieval-chain-exclusive', 'distinct-models-need-small-ctx'])
  })
})

describe('跨模型角色按"取值相同的一组助手"出行（真实例里 9 个内置助手判定逐字相同）', () => {
  const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })

  it('两个助手同判定 ⇒ 只一行，并说清是几个、是哪几个', () => {
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [roleVerdict('甲', smallCtx), roleVerdict('乙', smallCtx)]
      })
    )
    const group = rows.filter((r) => r.id.startsWith('distinct-roles:'))
    expect(group).toHaveLength(1)
    expect(group[0]!.id).toBe('distinct-roles:甲')
    expect(group[0]!.params).toMatchObject({ count: 2, names: '甲、乙' })
    expect(group[0]!.valueKey).toBe('judgement.value.distinctScope.any')
  })

  it('判定不同 ⇒ 一行一组，两组的码各说各的（分组不许把 ② 抹平成 ①）', () => {
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [
          roleVerdict('不碰知识库', smallCtx),
          roleVerdict('绑了本地 embedding 库', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: true })
        ]
      })
    )
    const groups = rows.filter((r) => r.id.startsWith('distinct-roles:'))
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => [g.id, g.valueKey, g.reasonCodes])).toEqual([
      ['distinct-roles:不碰知识库', 'judgement.value.distinctScope.any', ['distinct-roles-allowed']],
      ['distinct-roles:绑了本地 embedding 库', 'judgement.value.distinctScope.none', ['retrieval-chain-exclusive']]
    ])
  })

  it('150：同样"走检索链"但 embedding 落点不同 ⇒ 两组不许并成一行（并了就把差别抹平）', () => {
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [
          roleVerdict('本地 embedding', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: true }),
          roleVerdict('内置 CPU embedding', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: false })
        ]
      })
    )
    const groups = rows.filter((r) => r.id.startsWith('distinct-roles:'))
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.valueKey)).toEqual([
      'judgement.value.distinctScope.none',
      'judgement.value.distinctScope.any'
    ])
  })
})

describe('队列与判定行', () => {
  it('此刻没有队列 ⇒ 标 unavailable（**不等于**"测得不会排队"）', () => {
    const r = row(buildLocalJudgementRows(report()), 'slot-queue')
    expect(r.sourceCode).toBe('unavailable')
    expect(r.valueKey).toBe('judgement.value.no-queue-now')
  })

  it('有队列 ⇒ 在跑/排队/容量三个数原样带过去，标 measured 并注明是这一刻的观测', () => {
    const rows = buildLocalJudgementRows(report({ slots: [{ origin: '127.0.0.1:11434', busy: 1, waiting: 2, capacity: 1 }] }))
    const r = row(rows, 'slot-queue:127.0.0.1:11434')
    expect(r.params).toMatchObject({ busy: 1, waiting: 2, capacity: 1 })
    expect(r.sourceCode).toBe('measured')
    expect(r.noteKey).toBe('judgement.note.observed-now')
  })

  it('判定过期 ⇒ 来源档降级为 no-measurement；未过期是 measured', () => {
    const base = { key: 'p::m', model: 'm', capability: 'native_tools_ok', samples: 3, nativeHits: 3, delegationEnabled: true }
    const fresh = row(buildLocalJudgementRows(report({ delegations: [{ ...base, stale: false }] })), 'delegation:p::m')
    const stale = row(buildLocalJudgementRows(report({ delegations: [{ ...base, stale: true }] })), 'delegation:p::m')
    expect(fresh.sourceCode).toBe('measured')
    expect(stale.sourceCode).toBe('no-measurement')
    expect(stale.noteKey).toBe('judgement.note.stale')
    // 反向对照：开关与判定是两件事，开着委派也要另给一句"已被点名允许"
    expect(fresh.noteKey).toBe('judgement.note.delegation-on')
  })
})

describe('没有派生数：这块屏上不许出现算术得出的结论', () => {
  it('行的种类是封闭清单（新增任何"算出来的行"都要先有实测依据）', () => {
    const ids = buildLocalJudgementRows(report()).map((r) => r.id)
    expect(ids).toEqual([
      'vram-total',
      'vram-used-live',
      'chat-slots',
      'chat-embed-overlap',
      'distinct-roles:不碰知识库的助手',
      'slot-queue'
    ])
  })

  it('并行数取自判据本身，不是"总显存 ÷ 某个模型体积"', () => {
    const rows = buildLocalJudgementRows(report())
    expect(row(rows, 'chat-slots').params).toEqual({ n: planLocalCapacity({ totalVramMiB: 4096 }).maxConcurrentChatSlots })
  })
})

describe('四语字典逐码对号（动态拼 key 的死角，parity 扫不到）', () => {
  const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
  const allRows = [
    ...buildLocalJudgementRows(report()),
    ...buildLocalJudgementRows(report({ totalVramMiB: 12288, capacity: planLocalCapacity({ totalVramMiB: 12288 }) })),
    ...buildLocalJudgementRows(report({ totalVramMiB: null, capacity: planLocalCapacity({ totalVramMiB: null }) })),
    ...buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        liveVram: { available: false, rows: [] },
        slots: [{ origin: 'o1', busy: 1, waiting: 1, capacity: 1 }],
        delegations: [{ key: 'k', model: 'm', capability: 'fence_only', samples: 3, nativeHits: 0, stale: true, delegationEnabled: false }],
        roleVerdicts: [
          // 三个 scope 取值 + 两条检索链注都要在这一堆行里各出现一次，四本字典才有得对号
          roleVerdict('A', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: true }),
          roleVerdict('B', smallCtx, { childUsesRetrieval: true, retrievalHitsLocalEndpoint: false }),
          roleVerdict('C', smallCtx)
        ]
      })
    )
  ]

  const keys = new Set<string>()
  for (const r of allRows) {
    keys.add(r.labelKey)
    keys.add(r.valueKey)
    keys.add(`judgement.source.${r.sourceCode}`)
    if (r.noteKey) keys.add(r.noteKey)
    for (const c of r.reasonCodes) keys.add(`judgement.reason.${c}`)
  }
  // 判定取值是静态映射，但码来自存储，四本都要有
  for (const cap of ['native_tools_ok', 'fence_only', 'no_delegation', 'unknown']) {
    keys.add(`judgement.value.capability.${cap}`)
  }

  it('收集到的每一个键，四本文案都存在且非空', () => {
    const missing: string[] = []
    for (const k of keys) {
      for (const [name, dict] of DICTS) {
        const v = dict[k]
        if (!v || !v.trim()) missing.push(`${name}: ${k}`)
      }
    }
    expect(missing, `缺文案：\n${missing.join('\n')}`).toEqual([])
  })

  it('这条用例本身不是空的（至少覆盖到 30 个键，否则说明上游行变少了）', () => {
    expect(keys.size).toBeGreaterThanOrEqual(30)
  })
})
