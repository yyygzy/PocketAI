// 本机判据屏的**只读视图**（V4-Iter-146）——零依赖，所以住在 shared
//
// 这块屏唯一的存在理由是方案 §140 立的那条纪律：**"测得"与"保守默认"必须分开显示，不许把默认画成事实**。
// 所以每一行自带一个 `sourceCode`，界面只按码出文案（同 142 的三态徽标、145 的理由码一套做法）；
// 判据本身一律由主进程算好后送来，**渲染层不参与判断**——在渲染层再算一遍就是第二份口径，两处迟早漂移。
//
// 为什么这里重复声明了 `CapacityDecisionView`：判据逻辑在 `src/main/agent/local-capacity.ts`，
// 而 shared 不许反向依赖 main。这里重复的是**形状**不是**口径**：取值仍然只有 `planLocalCapacity` 一个出处，
// 主进程把真决策赋给这个形状时 TS 会做赋值检查；用例再把三个真实档（4GiB 实测 / 12GiB 未实测 / 采不到）
// 逐个喂进 `buildLocalJudgementRows` 钉住语义。

/** 与 `main/agent/local-capacity.ts` 的 `LocalCapacityDecision` 同形（见文件头的说明） */
export interface CapacityDecisionView {
  maxConcurrentChatSlots: number
  allowChatEmbedOverlap: boolean
  rolesMayUseDistinctModels: boolean
  measured: boolean
  reasons: string[]
}

/** 与 `mayAssignDistinctModelRole` 的返回同形 */
export interface DistinctRoleVerdictView {
  allowed: boolean
  reasons: string[]
}

/** 判据屏的数据：一次采集的**全部事实来源**，界面不再自己取任何数 */
export interface LocalJudgementReport {
  /** 这份报告生成的时刻（ms epoch）。界面必须显示：显存实占是"这一刻"的读数，不是常量 */
  collectedAt: number
  /** 判据据以计算的总显存——与 141 闸门读的是**同一次读取**（见 local-slot 的 capacitySnapshot） */
  totalVramMiB: number | null
  capacity: CapacityDecisionView
  /** 现采的显存实占。`available: false` ⇒ 无独显 / 驱动不在 / 超时 / Mac ⇒ 界面画"采不到" */
  liveVram: { available: boolean; rows: Array<{ name: string; totalMiB: number | null; usedMiB: number | null }> }
  /** 141 的槽位现状（观察用）。空数组 = 本机此刻没有本地推理队列，**不等于"测得不会排队"** */
  slots: Array<{ origin: string; busy: number; waiting: number; capacity: number }>
  /**
   * 跨模型角色的第二条合取按**助手**算：绑了知识库、或工具面允许 `kb_search` ⇒ 这条编排走检索链。
   * 一个助手一行，因为"这次编排走不走检索"是助手级事实，不是机器级事实。
   */
  roleVerdicts: Array<{ assistantName: string; childUsesRetrieval: boolean; verdict: DistinctRoleVerdictView }>
  /** 每台被判定过的模型的委派能力（复用 142 的视图，不另判一次） */
  delegations: Array<{
    key: string
    model: string
    capability: string
    samples: number
    nativeHits: number
    stale: boolean
    delegationEnabled: boolean
  }>
}

/**
 * 一行的来源档。**只有这三档**：把"保守默认"或"采不到"降级成同一个"未知"就会撒谎——
 * 用户需要区分"这台机器没测过所以不敢放宽"（no-measurement）与"这次没读到数"（unavailable）。
 */
export type JudgementSourceCode = 'measured' | 'no-measurement' | 'unavailable'

export interface JudgementRow {
  /** 稳定 id：用例与将来的自动化都按它找行，不许按文案找 */
  id: string
  labelKey: string
  valueKey: string
  /** 取值文案的参数（数字/名称原样带过去，界面不做二次计算） */
  params?: Record<string, string | number>
  sourceCode: JudgementSourceCode
  /** 判据理由码：逐字来自 `planLocalCapacity` / `mayAssignDistinctModelRole`，界面按码出文案 */
  reasonCodes: string[]
  /** 这一行额外的说明文案键（不是判据码，例如"这个读数不参与判据"） */
  noteKey?: string
}

/**
 * 判据的三个"档位码"：整屏只出现一次（挂在并行数那一行），
 * 每一行都重复一遍会把"这一档没测过"刷成一屏噪音。
 */
const BUCKET_CODES = ['measured-bucket', 'no-measurement-for-bucket', 'vram-unknown']

/**
 * 跨模型角色按"取值相同的一组助手"出一行，不是一个助手一行。
 * 理由是本机真实例量到的：9 个内置助手的判定**逐字相同**（'*' 面里都有 kb_search），
 * 九行一模一样的话既刷不动人，也让人怀疑"是不是根本没在判"。分组后仍写清是几个、哪些（title 里）。
 */
interface RoleGroup {
  names: string[]
  allowed: boolean
  reasons: string[]
  childUsesRetrieval: boolean
}

function groupRoleVerdicts(report: LocalJudgementReport): RoleGroup[] {
  const byKey = new Map<string, RoleGroup>()
  for (const v of report.roleVerdicts) {
    const key = `${v.verdict.allowed}|${v.childUsesRetrieval}|${v.verdict.reasons.join(',')}`
    const g = byKey.get(key)
    if (g) g.names.push(v.assistantName)
    else
      byKey.set(key, {
        names: [v.assistantName],
        allowed: v.verdict.allowed,
        reasons: v.verdict.reasons,
        childUsesRetrieval: v.childUsesRetrieval
      })
  }
  return [...byKey.values()]
}

/**
 * 把报告摊成行。**这里出现的数字必须都是"读来的"**：140 的教训是"总显存 − 权重 − KV > 0 即放得下"
 * 这类算术会一律给出错答案，所以本屏**没有**"可同驻 N 台模型"这种行，只有判据自己给出的取值。
 */
export function buildLocalJudgementRows(report: LocalJudgementReport): JudgementRow[] {
  const rows: JudgementRow[] = []
  const d = report.capacity

  rows.push({
    id: 'vram-total',
    labelKey: 'judgement.totalVram',
    valueKey: report.totalVramMiB === null ? 'judgement.value.unavailable' : 'judgement.value.mib',
    params: report.totalVramMiB === null ? undefined : { mib: report.totalVramMiB },
    sourceCode: report.totalVramMiB === null ? 'unavailable' : 'measured',
    reasonCodes: [],
    // 总量是**启动快照**（140 记下的那条约束：getHardwareInfo() 采一次并缓存），
    // 与下面那个"现采的已用"不是同一时刻的两个数——不注明就会让用户以为整屏都是实时值
    noteKey: 'judgement.note.startup-snapshot'
  })

  const live = report.liveVram
  const listed = live.rows.map((g) => `${g.name} ${g.usedMiB ?? '?'}/${g.totalMiB ?? '?'} MiB`).join(' · ')
  rows.push({
    id: 'vram-used-live',
    labelKey: 'judgement.usedVramLive',
    valueKey: live.available ? 'judgement.value.list' : 'judgement.value.unavailable',
    params: live.available ? { list: listed } : undefined,
    sourceCode: live.available ? 'measured' : 'unavailable',
    reasonCodes: [],
    // 用户 2026-10-16 选定：实时读数**只作观察**，不参与判据（判据只认实测表那一档）
    noteKey: live.available ? 'judgement.note.not-a-capacity-input' : undefined
  })

  rows.push({
    id: 'chat-slots',
    labelKey: 'judgement.chatSlots',
    valueKey: 'judgement.value.count',
    params: { n: d.maxConcurrentChatSlots },
    sourceCode: d.measured ? 'measured' : 'no-measurement',
    reasonCodes: d.reasons.filter((r) => BUCKET_CODES.includes(r) || r === 'concurrency-buys-nothing-measured')
  })

  rows.push({
    id: 'chat-embed-overlap',
    labelKey: 'judgement.chatEmbedOverlap',
    valueKey: d.allowChatEmbedOverlap ? 'judgement.value.allowed' : 'judgement.value.blocked',
    sourceCode: d.measured ? 'measured' : 'no-measurement',
    reasonCodes: d.reasons.includes('chat-embed-exclusive') ? ['chat-embed-exclusive'] : []
  })


  for (const g of groupRoleVerdicts(report)) {
    const reasons =
      g.reasons.includes('distinct-roles-not-measured') && d.reasons.includes('distinct-models-need-small-ctx')
        ? [...g.reasons, 'distinct-models-need-small-ctx']
        : g.reasons
    rows.push({
      // 组标识取"组里第一个助手的名字"：单助手时行 id 与逐个助手时完全一致，用例不必跟着换
      id: `distinct-roles:${g.names[0]}`,
      labelKey: 'judgement.distinctRoles',
      valueKey: g.allowed ? 'judgement.value.allowed' : 'judgement.value.blocked',
      params: { count: g.names.length, names: g.names.join('、') },
      sourceCode: d.measured ? 'measured' : 'no-measurement',
      noteKey: g.childUsesRetrieval ? 'judgement.note.retrieval-chain' : undefined,
      // 合取的"哪一条没过"逐码列出来（145 的用例就是钉这两条各自能否掉）
      reasonCodes: reasons
    })
  }

  if (report.slots.length === 0) {
    rows.push({
      id: 'slot-queue',
      labelKey: 'judgement.slotQueue',
      valueKey: 'judgement.value.no-queue-now',
      // 此刻没有队列 ≠ 测得"不会排队"：给 unavailable，免得把一次观察画成常驻事实
      sourceCode: 'unavailable',
      reasonCodes: []
    })
  } else {
    for (const s of report.slots) {
      rows.push({
        id: `slot-queue:${s.origin}`,
        labelKey: 'judgement.slotQueue',
        valueKey: 'judgement.value.queue',
        params: { origin: s.origin, busy: s.busy, waiting: s.waiting, capacity: s.capacity },
        sourceCode: 'measured',
        reasonCodes: [],
        noteKey: 'judgement.note.observed-now'
      })
    }
  }

  for (const c of report.delegations) {
    rows.push({
      id: `delegation:${c.key}`,
      labelKey: 'judgement.delegation',
      valueKey: `judgement.value.capability.${c.capability}`,
      params: { model: c.model, hits: c.nativeHits, samples: c.samples },
      // 判定是"探出来的" ⇒ 测得；但镜像摘要变了（stale）就不能再当事实，来源档降级
      sourceCode: c.stale ? 'no-measurement' : 'measured',
      reasonCodes: [],
      noteKey: c.stale ? 'judgement.note.stale' : c.delegationEnabled ? 'judgement.note.delegation-on' : undefined
    })
  }

  return rows
}
