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
import { planLocalCapacity, mayAssignDistinctModelRole } from '../src/main/agent/local-capacity'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const DICTS: Array<[string, Record<string, string>]> = [['zh', zh], ['en', en], ['ja', ja], ['ko', ko]]

const report = (over: Partial<LocalJudgementReport> = {}): LocalJudgementReport => ({
  collectedAt: 1_700_000_000_000,
  totalVramMiB: 4096,
  capacity: planLocalCapacity({ totalVramMiB: 4096 }),
  liveVram: { available: true, rows: [{ name: 'GTX 1050 Ti', totalMiB: 4096, usedMiB: 3149 }] },
  slots: [],
  roleVerdicts: [
    {
      assistantName: '不碰知识库的助手',
      childUsesRetrieval: false,
      verdict: mayAssignDistinctModelRole(planLocalCapacity({ totalVramMiB: 4096 }), { childUsesRetrieval: false })
    }
  ],
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

describe('跨模型角色的两条合取：哪一条没过就说什么', () => {

  it('①没过（应用从不设 num_ctx）⇒ distinct-roles-not-measured + 那句"要显式设小上下文"', () => {
    const rows = buildLocalJudgementRows(report())
    const codes = row(rows, 'distinct-roles:不碰知识库的助手').reasonCodes
    expect(codes).toContain('distinct-roles-not-measured')
    expect(codes).toContain('distinct-models-need-small-ctx')
  })

  it('①过了但走检索链 ⇒ 只报 retrieval-chain-exclusive（第二条单独就能否掉）', () => {
    const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [
          {
            assistantName: '绑了知识库的助手',
            childUsesRetrieval: true,
            verdict: mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: true })
          }
        ]
      })
    )
    const r = row(rows, 'distinct-roles:绑了知识库的助手')
    expect(r.reasonCodes).toEqual(['retrieval-chain-exclusive'])
    expect(r.noteKey).toBe('judgement.note.retrieval-chain')
    expect(r.valueKey).toBe('judgement.value.blocked')
  })

  it('两条都过 ⇒ allowed，且码里说的是"两条合取都成立"', () => {
    const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [
          {
            assistantName: '不碰知识库的助手',
            childUsesRetrieval: false,
            verdict: mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: false })
          }
        ]
      })
    )
    const r = row(rows, 'distinct-roles:不碰知识库的助手')
    expect(r.valueKey).toBe('judgement.value.allowed')
    expect(r.reasonCodes).toEqual(['distinct-roles-allowed'])
  })
})

describe('跨模型角色按"取值相同的一组助手"出行（真实例里 9 个内置助手判定逐字相同）', () => {
  const smallCtx = planLocalCapacity({ totalVramMiB: 4096, numCtxSetByApp: true })

  it('两个助手同判定 ⇒ 只一行，并说清是几个、是哪几个', () => {
    const verdict = mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: false })
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [
          { assistantName: '甲', childUsesRetrieval: false, verdict },
          { assistantName: '乙', childUsesRetrieval: false, verdict }
        ]
      })
    )
    const group = rows.filter((r) => r.id.startsWith('distinct-roles:'))
    expect(group).toHaveLength(1)
    expect(group[0]!.id).toBe('distinct-roles:甲')
    expect(group[0]!.params).toMatchObject({ count: 2, names: '甲、乙' })
    expect(group[0]!.valueKey).toBe('judgement.value.allowed')
  })

  it('判定不同 ⇒ 一行一组，两组的码各说各的（分组不许把 ② 抹平成 ①）', () => {
    const rows = buildLocalJudgementRows(
      report({
        capacity: smallCtx,
        roleVerdicts: [
          { assistantName: '不碰知识库', childUsesRetrieval: false, verdict: mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: false }) },
          { assistantName: '绑了知识库', childUsesRetrieval: true, verdict: mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: true }) }
        ]
      })
    )
    const groups = rows.filter((r) => r.id.startsWith('distinct-roles:'))
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => [g.id, g.valueKey, g.reasonCodes])).toEqual([
      ['distinct-roles:不碰知识库', 'judgement.value.allowed', ['distinct-roles-allowed']],
      ['distinct-roles:绑了知识库', 'judgement.value.blocked', ['retrieval-chain-exclusive']]
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
          { assistantName: 'A', childUsesRetrieval: true, verdict: mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: true }) },
          { assistantName: 'B', childUsesRetrieval: false, verdict: mayAssignDistinctModelRole(smallCtx, { childUsesRetrieval: false }) }
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
