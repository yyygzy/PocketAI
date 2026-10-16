// 本地显存容量判据（V4-Iter-140）——只出判据，不改任何调用点（第一个消费者是 V4-Iter-141 的槽位调度）
//
// 为什么是「实测表 + 保守默认」而不是公式（V-0 本机 4GiB 实测把初稿一条结论顶回去了）：
//   · 3b(ctx2048) + coder-1.5b(ctx2048) **能**同驻，nvidia-smi 读到 3149MiB —— 初稿写的"两个 chat 模型
//     不能同驻"是错的，那只是 Ollama 默认 ctx(4096) 那一档的表现；
//   · 3b(ctx2048) + bge-m3 **不能**同驻，尽管权重合计才 2.7GiB < 4GiB（embed 一到就把对话模型顶出去，
//     随后一次请求付 3045ms 冷启动）；
//   · 同驻与不同驻之间只差 128MiB 就翻边。
//   ⇒ 任何「总显存 − 权重和 − KV > 0 即放得下」的算术都会给出错答案。所以本模块**不接受权重输入**，
//   只承认「在哪张卡、哪个 ctx 真测过」的行；查不到行就退回保守默认，并把退回的理由以码回传。
//
// 纯函数住在这里（而不是 steward/hardware.ts 或 ollama-runtime.ts）：那两个模块依赖 electron/portable，
// 测试里常被整模块打桩（同 V4-Iter-123 那条教训），判据放那儿就等于测不到。

/** 判据理由码：界面与日志按码出文案，不解析中文 */
export type CapacityReasonCode =
  /** 该显存档有本机实测数据，结论来自实测表 */
  | 'measured-bucket'
  /** 该显存档没有实测数据（需要第二台机器），按保守默认 */
  | 'no-measurement-for-bucket'
  /** 总显存采不到（Mac / 无 nvidia-smi / 无独显），按保守默认 */
  | 'vram-unknown'
  /** 实测：对话模型与 embedding 模型不同驻 —— 低配的真实硬约束是这条，不是权重放不下 */
  | 'chat-embed-exclusive'
  /** 实测：跨模型同驻只在显式小 ctx 下成立；应用从未设置 num_ctx，跟随 Ollama 默认 ⇒ 不给跨模型放行 */
  | 'distinct-models-need-small-ctx'
  /** 实测：跨模型并发不比串行快（7597ms vs 8283ms，差 686ms 属噪声），并发槽保持 1 */
  | 'concurrency-buys-nothing-measured'

export interface LocalCapacityInput {
  /** GPU 总显存（MiB）。null / 非正数 = 采不到 */
  totalVramMiB: number | null
  /**
   * 应用是否显式设置了 num_ctx。
   * 今天全仓零命中 ⇒ 传 false 或不传；跨模型角色的放行以"小 ctx 实测过"为条件，
   * 所以没设 ctx 时宁可少放（默认 4096 那一档实测是互相顶出的）。
   */
  numCtxSetByApp?: boolean
}

export interface LocalCapacityDecision {
  /** 同一时刻允许几个"对话类"本地请求并行（agent 主循环 / 规划 / 摘要 / rerank / HyDE 都算对话类） */
  maxConcurrentChatSlots: number
  /** 是否允许 embedding 与对话并行 */
  allowChatEmbedOverlap: boolean
  /** 是否允许不同角色使用不同模型（跨模型角色） */
  rolesMayUseDistinctModels: boolean
  /** true = 结论来自实测表；false = 来自保守默认（界面必须把这两种状态分开显示，别把默认画成事实） */
  measured: boolean
  reasons: CapacityReasonCode[]
}

/** 一 MiB 的字节数。换算必须有名有姓：bytes/MiB 写混会把"实测档"翻成"未实测档"（静默失去错峰） */
export const MIB_BYTES = 1048576

/**
 * 从 GPU 快照里取**最大的一块 cuda 显存**（bytes → MiB）。
 * 非 NVIDIA / 采不到 / 脏值 ⇒ null（判据据此走"未实测"分支，而不是猜一个数）。
 * 多卡取最大：本地推理今天只会落在一块卡上，取最大是"最宽松但仍在实测范围内"的选择。
 */
export function largestCudaVramMiB(gpus: ReadonlyArray<{ cuda: boolean; memory?: number }>): number | null {
  let best = 0
  for (const g of gpus ?? []) {
    if (!g?.cuda) continue
    const m = g.memory
    if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0) continue
    if (m > best) best = m
  }
  return best > 0 ? Math.round(best / MIB_BYTES) : null
}

/** 4GiB 及以下：目前唯一在本机测过的档（GTX 1050 Ti 4096MiB / Ollama 0.33.1） */
const MEASURED_MAX_VRAM_MIB = 4096

/** 采不到或没测过的档一律走这份保守默认 */
const CONSERVATIVE: Omit<LocalCapacityDecision, 'reasons'> = {
  maxConcurrentChatSlots: 1,
  allowChatEmbedOverlap: false,
  rolesMayUseDistinctModels: false,
  measured: false
}

function dedupeReasons<T extends string>(list: T[]): T[] {
  return list.filter((r, i) => list.indexOf(r) === i)
}

/**
 * 出容量判据。**只查表**——输入里没有权重体积、也没有 /api/ps 的驻留条数，
 * 因为它们都不能放宽结论：前者是 M10 证伪过的算术，后者是账面记账（V-0 里 ps 曾报三个同驻、
 * 合计恰好等于显存总量，而真生成时后者把前者顶掉）。要加这两个输入之前，先读这段注释。
 */
export function planLocalCapacity(input: LocalCapacityInput): LocalCapacityDecision {
  const total = input.totalVramMiB

  if (total === null || !Number.isFinite(total) || total <= 0) {
    return {
      ...CONSERVATIVE,
      reasons: dedupeReasons(['vram-unknown', 'chat-embed-exclusive', 'concurrency-buys-nothing-measured'])
    }
  }

  if (total > MEASURED_MAX_VRAM_MIB) {
    // 更大的卡今天没有实测数据。不许因为"显存多"就放宽 —— 那正是初稿把一次驱逐当容量本质的错法。
    return {
      ...CONSERVATIVE,
      reasons: dedupeReasons(['no-measurement-for-bucket', 'chat-embed-exclusive', 'concurrency-buys-nothing-measured'])
    }
  }

  const reasons: CapacityReasonCode[] = ['measured-bucket', 'chat-embed-exclusive', 'concurrency-buys-nothing-measured']
  if (!input.numCtxSetByApp) reasons.push('distinct-models-need-small-ctx')

  return {
    maxConcurrentChatSlots: 1,
    allowChatEmbedOverlap: false,
    // 小 ctx 实测过同驻（3149MiB）才允许跨模型角色；未设 ctx 时按默认 4096 的实测结果走 ⇒ 不放行
    rolesMayUseDistinctModels: !!input.numCtxSetByApp,
    measured: true,
    reasons: dedupeReasons(reasons)
  }
}

// ---------- 145：跨模型角色与角色并发（在 140 的判据之上再加一条合取） ----------

/** 角色相关判据的理由码（界面/日志按码出文案，同上面的纪律） */
export type RoleReasonCode =
  /** 两条合取都成立：小 ctx 实测过同驻，且这些角色都不碰 embedding 检索链 */
  | 'distinct-roles-allowed'
  /** 第一条不成立：这一档没有"跨模型同驻"的实测数据（或应用没设小 ctx） */
  | 'distinct-roles-not-measured'
  /** 第二条不成立：角色要走检索链 ⇒ 一 embed 一把对话模型顶出去（M10 实测），跨模型同驻在这里翻车 */
  | 'retrieval-chain-exclusive'
  /** 有一条子 run 落在本地回环端点 ⇒ 这一轮整体按串行走（M6 并发买不到东西 + 141 的前台槽本就 =1） */
  | 'local-serial-measured'

export interface DistinctRoleVerdict {
  allowed: boolean
  reasons: RoleReasonCode[]
}

/**
 * 「这条编排能不能给不同角色配不同模型」——**两条合取，一条都不能省**（方案 §145 更正过初稿）：
 *  ① `decision.rolesMayUseDistinctModels`：V-0 实测 3b+coder 在 ctx≤2048 时确实同驻（3149MiB），
 *     但应用从不设 `num_ctx` ⇒ 今天恒 false；
 *  ② **这些角色都不走 embedding 检索链**：同驻被逐的那次实测就是"一个 embed 进来把对话模型顶出去"
 *     （M10），只写 ① 会把低配档错判成"可以开"。
 * 只做合取、不做算术：还是不许拿"总显存减权重减 KV > 0"当放行理由。
 */
export function mayAssignDistinctModelRole(
  decision: LocalCapacityDecision,
  opts: { childUsesRetrieval: boolean }
): DistinctRoleVerdict {
  const reasons: RoleReasonCode[] = []
  if (!decision.rolesMayUseDistinctModels) reasons.push('distinct-roles-not-measured')
  if (opts.childUsesRetrieval) reasons.push('retrieval-chain-exclusive')
  if (reasons.length > 0) return { allowed: false, reasons: dedupeReasons(reasons) }
  return { allowed: true, reasons: ['distinct-roles-allowed'] }
}

export interface RoleConcurrencyPlan {
  /** 同一轮编排里的多条子 run 是否可以并行发起 */
  parallel: boolean
  /** 同时在飞的最多条数（>=1） */
  maxParallel: number
  reasons: RoleReasonCode[]
}

/**
 * 「多条子 run 是并行还是串行」——按用户 2026-10-16 选定：**云并行、本地串行**。
 * 理由不是"云更快"而是本地并行**换不到东西**：M6 实测跨模型并发 7597ms vs 串行 8283ms（差 686ms 属噪声），
 * 而 141 的前台槽在 ≤4GiB 档就是 1 ⇒ 本地就算并发发出，也会在闸门排队，只会把"谁在等"变模糊。
 * 只要有一条子 run 落在本地回环端点上，这一轮就整体按串行走（不做半并行：一半在等一半在跑，
 * 预算与耗时更难解释）。
 */
export function planRoleConcurrency(opts: {
  /** 每条子 run 用的是哪家端点（true = 本地回环） */
  endpointsLocal: boolean[]
  requested: number
}): RoleConcurrencyPlan {
  const reasons: RoleReasonCode[] = []
  const requested = Math.max(1, opts.requested)
  if (opts.endpointsLocal.some((local) => local)) {
    reasons.push('local-serial-measured')
    return { parallel: false, maxParallel: 1, reasons }
  }
  return { parallel: requested > 1, maxParallel: requested, reasons }
}
