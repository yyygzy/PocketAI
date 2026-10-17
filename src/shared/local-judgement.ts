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

/**
 * 跨模型角色的取值（150 起不是一个布尔）：新口径下"放不放得开"取决于子落在哪，
 * 而这一屏是在"每次委派之前"看的，没有"这一次"可言 ⇒ 只能把两种落点各判一次再摊成三态。
 * 与 `main/agent/local-capacity.ts` 的 `DistinctRoleScope` 同形（这里重复的是形状，取值仍只有那一个出处）。
 */
export type DistinctRoleScopeView = 'not-allowed' | 'cloud-only' | 'any-endpoint'

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
   * 跨模型角色按**助手**算的一行事实（150）：
   *  · `childUsesRetrieval` —— 这条编排会不会走检索链（绑了库 / 工具面有 kb_search）；
   *  · `retrievalHitsLocalEndpoint` —— 那条检索链的 embedding 会不会落到本机推理端点（第二条合取真正判的是它）；
   *  · `scope` —— 两种落点各判一次后的取值；`reasons` 是拦下来的那些码。
   */
  roleVerdicts: Array<{
    assistantName: string
    childUsesRetrieval: boolean
    retrievalHitsLocalEndpoint: boolean
    scope: DistinctRoleScopeView
    reasons: string[]
  }>
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
  scope: DistinctRoleScopeView
  reasons: string[]
  childUsesRetrieval: boolean
  retrievalHitsLocalEndpoint: boolean
}

function groupRoleVerdicts(report: LocalJudgementReport): RoleGroup[] {
  const byKey = new Map<string, RoleGroup>()
  for (const v of report.roleVerdicts) {
    // 分组键带上两条检索链事实：只有 scope 相同就并组，会把"不碰库"与"碰库但不吃显存"画成同一行
    const key = `${v.scope}|${v.childUsesRetrieval}|${v.retrievalHitsLocalEndpoint}|${v.reasons.join(',')}`
    const g = byKey.get(key)
    if (g) g.names.push(v.assistantName)
    else
      byKey.set(key, {
        names: [v.assistantName],
        scope: v.scope,
        reasons: v.reasons,
        childUsesRetrieval: v.childUsesRetrieval,
        retrievalHitsLocalEndpoint: v.retrievalHitsLocalEndpoint
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
    const merged =
      g.reasons.includes('distinct-roles-not-measured') && d.reasons.includes('distinct-models-need-small-ctx')
        ? [...g.reasons, 'distinct-models-need-small-ctx']
        : g.reasons
    // 去重：这条码既可能已经在角色判定里、也可能由容量判定补一句（两处各说一遍）。
    // 146 那版没加分隔符时重复被空格吞掉看不出来，149 加了「·」之后同一句会连着出现两次 ⇒ 先收敛再画。
    const reasons = merged.filter((r, i) => merged.indexOf(r) === i)
    rows.push({
      // 组标识取"组里第一个助手的名字"：单助手时行 id 与逐个助手时完全一致，用例不必跟着换
      id: `distinct-roles:${g.names[0]}`,
      labelKey: 'judgement.distinctRoles',
      /**
       * 150：这一行的取值是**三态**（落点无关地允许 / 只允许云端落点 / 不允许），不再是"允许/不允许"。
       * 164：界面上那三个值改成各自语言的自然说法（zh「允许（本地、云端都能跑）／只能跑在云端／不允许」），
       *       "落点"这个行话不再出现在任何一本字典的取值里，只在本文件当解释用——三态的**形状**没变，变的只是措辞。
       * 三个键在这里写成字面量而不是拼出来——界面的静态映射（`DISTINCT_SCOPE_KEY`）与逐键字典用例
       * 都依赖"键看得见"（146 的 `judgement.reason.${码}` 就是拼出来才漏扫的）。
       */
      valueKey:
        g.scope === 'any-endpoint'
          ? 'judgement.value.distinctScope.any'
          : g.scope === 'cloud-only'
            ? 'judgement.value.distinctScope.cloud-only'
            : 'judgement.value.distinctScope.none',
      params: { count: g.names.length, names: g.names.join('、') },
      sourceCode: d.measured ? 'measured' : 'no-measurement',
      // 两条检索链事实分开说：只说"会走向量检索"会把"其实不吃这张卡"那一格也说成拦的理由
      noteKey: g.retrievalHitsLocalEndpoint
        ? 'judgement.note.retrieval-hits-local-embedding'
        : g.childUsesRetrieval
          ? 'judgement.note.retrieval-chain'
          : undefined,
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
