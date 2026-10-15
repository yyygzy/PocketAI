// 委派能力判卷（V4-Iter-142）——纯函数，零依赖
//
// 这里只做一件事：给定"探针收到的若干条回复"，判这台模型当不当得了中心管控者。
// 为什么住 shared 且零依赖：发起请求那部分要碰 providerManager/logger（electron 链），
// 判卷必须能脱离它们被逐条断言（同 V4-Iter-123 那条"纯函数别寄居在被整块打桩的模块里"）。
//
// 三条来自实测的硬规矩（V-0 / 决策①，都不是推理）：
//   · **只有原生 tools 路径算数**：M8 实测同一批模型走"把协议写进提示词"那条路全部 0/3，
//     连 3b 都从"4/4 会派活"退化成"自己写汇报" ⇒ 探针必须带 tools 发，判卷只认 tool_calls。
//   · **fence_only 是诊断态，不是可用态**：`qwen2.5-coder:1.5b` 想调工具，但它自发写 ```json 围栏，
//     而引擎的解析器只认 ```tool_call（text-tool-protocol.ts:30）。决策①已定论不放宽标签
//     （50 例实测：放宽把它从 25% 抬到 50%，仍够不到管控者）⇒ 本文件的宽松匹配**只用于给出这一态**，
//     绝不能被当成"引擎以后能抽到"。tests 里有一条反向对照专门守这条界线。
//   · **请求失败不等于"不派活"**：失败要出 unknown，否则一次网络抖动就把一台能用的模型标成不能用。

/** 三态 + 一个"没能判"的兜底态（样本不足或有失败时用，不许硬猜） */
export type DelegateCapability = 'native_tools_ok' | 'fence_only' | 'no_delegation' | 'unknown'

/** 探针用的假工具：只考察"能不能派活"，不碰任何真工具，也不产生副作用 */
export const DELEGATE_PROBE_TOOL = 'delegate_probe'

/** 少于这个次数不出结论（M7 里 3b 是 4/4，但单次不足以定论；稳定性本身仍是待测项） */
export const MIN_PROBE_RUNS = 3

export interface ProbeReply {
  /** 一次请求是否成功拿到回复（失败 ⇒ 不参与判卷，直接拖垮整轮结论） */
  ok: boolean
  /** 原生 tool_calls 里有没有对探针工具的合法调用 */
  nativeCall: boolean
  /** 正文里有没有"围栏 + {name, arguments}"形状（含 ```json 这类错标签） */
  fencedCall: boolean
}

export interface ProbeJudgement {
  capability: DelegateCapability
  /** 参与判卷的样本数 */
  samples: number
  nativeHits: number
  fenceHits: number
  /** capability = unknown 时的原因码，界面据此出文案 */
  reason?: 'no_samples' | 'some_requests_failed' | 'insufficient_runs'
}

/**
 * 判一轮探针。顺序敏感的是计数，不是顺序本身。
 * 规则（写死在这里，别散到调用方）：
 *  - 任一请求失败 ⇒ unknown（失败不是证据）
 *  - 有效样本 < MIN_PROBE_RUNS ⇒ unknown
 *  - 每一次都发出合法原生调用 ⇒ native_tools_ok
 *  - 一次原生调用都没有、但有过围栏形状 ⇒ fence_only
 *  - 其余 ⇒ no_delegation（它会调，只是不稳：交给界面按"不稳定"说，不说"能"）
 */
export function judgeDelegateProbe(replies: ProbeReply[]): ProbeJudgement {
  const samples = replies.length
  if (samples === 0) {
    return { capability: 'unknown', samples: 0, nativeHits: 0, fenceHits: 0, reason: 'no_samples' }
  }
  const failed = replies.filter((r) => !r.ok).length
  if (failed > 0) {
    const nativeHits = replies.filter((r) => r.nativeCall).length
    const fenceHits = replies.filter((r) => r.fencedCall && !r.nativeCall).length
    return { capability: 'unknown', samples, nativeHits, fenceHits, reason: 'some_requests_failed' }
  }
  if (samples < MIN_PROBE_RUNS) {
    const nativeHits = replies.filter((r) => r.nativeCall).length
    const fenceHits = replies.filter((r) => r.fencedCall && !r.nativeCall).length
    return { capability: 'unknown', samples, nativeHits, fenceHits, reason: 'insufficient_runs' }
  }
  const nativeHits = replies.filter((r) => r.nativeCall).length
  const fenceHits = replies.filter((r) => r.fencedCall && !r.nativeCall).length
  if (nativeHits === samples) return { capability: 'native_tools_ok', samples, nativeHits, fenceHits }
  if (nativeHits === 0 && fenceHits > 0) return { capability: 'fence_only', samples, nativeHits, fenceHits }
  return { capability: 'no_delegation', samples, nativeHits, fenceHits }
}

// ---------- 探针请求体（发出去的形状与判卷口径必须同源，否则"探的"和"用的"两码事） ----------

export interface ProbeRequestShape {
  systemPrompt: string
  userPrompt: string
  toolName: string
  /** 允许出现的 role 值；调用方构造 tools schema 与校验参数都用它，防两处漂移 */
  roles: readonly string[]
  minTaskChars: number
}

export const DELEGATE_PROBE: ProbeRequestShape = {
  systemPrompt:
    '你是中心调度代理。你自己没有任何资料也不写正文，必须调用工具把任务派给一个子代理。禁止用自然语言作答。',
  userPrompt: '帮我写一段给老板看的汇报，说明我们知识库检索为什么慢。',
  toolName: DELEGATE_PROBE_TOOL,
  roles: ['researcher', 'writer', 'reviewer'] as const,
  minTaskChars: 8
}

/** arguments 是否是一次合法委派（role 在枚举内 + task 足够长） */
export function isLegalDelegateArgs(args: unknown, shape: ProbeRequestShape = DELEGATE_PROBE): boolean {
  if (typeof args !== 'object' || args === null) return false
  const rec = args as Record<string, unknown>
  if (typeof rec.role !== 'string' || !shape.roles.includes(rec.role)) return false
  if (typeof rec.task !== 'string') return false
  return rec.task.trim().length >= shape.minTaskChars
}

/** 文本里是否存在"围栏 + {name: 探针工具, arguments: {...}}"的形状（诊断用，见文件头） */
export function hasFencedDelegateCall(text: string, toolName: string = DELEGATE_PROBE_TOOL): boolean {
  const blocks = [...String(text ?? '').matchAll(/```[a-zA-Z_\-*]*[ \t]*\r?\n?([\s\S]*?)```/g)]
  for (const b of blocks) {
    try {
      const obj = JSON.parse(String(b[1] ?? '')) as Record<string, unknown>
      if (obj?.name !== toolName) continue
      const args = obj.arguments
      if (typeof args === 'object' && args !== null) return true
    } catch {
      // 不是 JSON 的围栏块（示例代码等）跳过：宁可漏判 fence_only，也不把普通代码块当调用
      continue
    }
  }
  return false
}

/**
 * 从一次流式回复里抽出探针判据。
 * 原生 tool_calls 优先：只要有一条名字对得上且参数合法，就算 nativeCall。
 */
export function replyToProbeSample(input: {
  content: string
  toolCalls?: Array<{ name: string; arguments: string }> | null
  requestOk?: boolean
}): ProbeReply {
  if (input.requestOk === false) return { ok: false, nativeCall: false, fencedCall: false }
  const calls = input.toolCalls ?? []
  const nativeCall = calls.some((c) => {
    if (c.name !== DELEGATE_PROBE.toolName) return false
    try {
      return isLegalDelegateArgs(JSON.parse(c.arguments || '{}'))
    } catch {
      return false
    }
  })
  return { ok: true, nativeCall, fencedCall: !nativeCall && hasFencedDelegateCall(input.content) }
}

// ---------- 存储 ----------

export interface DelegateCapabilityEntry {
  /** `providerId::model`，与文本协议开关同一个键形状（见 text-protocol-prefs 的 textProtocolKey） */
  key: string
  providerId: string
  model: string
  capability: DelegateCapability
  /** 判卷时的样本数与命中数：面板要说"3/3"而不是凭空断言 */
  samples: number
  nativeHits: number
  /** 本地模型的镜像摘要；云端为空 ⇒ 无失效键，只能重探 */
  digest: string
  checkedAt: number
}

/** 一次探测的返回：判定 + 探测本身出错的原因（null = 正常出结论）。界面不许把 error 当"不支持" */
export interface DelegateProbeResult {
  entry: DelegateCapabilityEntry
  error: string | null
}

/** 列表视图：多带一个 stale（本地模型镜像换了摘要 ⇒ 旧结论过期） */
export interface DelegateCapabilityView extends DelegateCapabilityEntry {
  stale: boolean
  /**
   * 决策③（默认关、手动开）：这台模型是否被用户点名允许顺序委派。
   * 判定与开关是两件事——`native_tools_ok` 只说明"派得出活"，开不开由用户决定，
   * 所以未开启的可当管控者模型这一位是 false，界面不许把它显示成"已启用"。
   */
  delegationEnabled: boolean
}

export const MAX_DELEGATE_ENTRIES = 200
const CAPABILITIES: DelegateCapability[] = ['native_tools_ok', 'fence_only', 'no_delegation', 'unknown']
const MAX_PART_CHARS = 200

/** 清洗落盘内容：脏项整条丢掉（不给默认值，免得把"没探过"写成"不派活"） */
export function normalizeDelegateEntries(raw: unknown): DelegateCapabilityEntry[] {
  if (!Array.isArray(raw)) return []
  const out: DelegateCapabilityEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : ''
    const model = typeof rec.model === 'string' ? rec.model.trim() : ''
    if (!providerId || !model) continue
    if (providerId.length > MAX_PART_CHARS || model.length > MAX_PART_CHARS) continue
    const capability = CAPABILITIES.includes(rec.capability as DelegateCapability)
      ? (rec.capability as DelegateCapability)
      : null
    if (!capability) continue
    const key = delegateKey(providerId, model)
    if (seen.has(key)) continue
    seen.add(key)
    const asInt = (v: unknown, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0
    out.push({
      key,
      providerId,
      model,
      capability,
      samples: asInt(rec.samples, 99),
      nativeHits: asInt(rec.nativeHits, 99),
      digest: typeof rec.digest === 'string' ? rec.digest.slice(0, 128) : '',
      checkedAt: asInt(rec.checkedAt, Number.MAX_SAFE_INTEGER)
    })
  }
  return out.slice(0, MAX_DELEGATE_ENTRIES)
}

/** 键形状与文本协议开关一致（`providerId::model`），两处共用一个函数，别各自拼 */
export function delegateKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

// ---------- 失效判定（纯函数：三态各有分支，主进程那份只负责取数） ----------

interface NamedModel {
  name: string
  digest: string
}

/**
 * 在 tags 清单里找这条模型现在的镜像。
 * **同名命中优先于同族命中**：一台机器常同时有 `qwen2.5:3b` 与 `qwen2.5:7b`，
 * 只按"冒号前缀相同"取第一条会把它们混为一谈 ⇒ 拿错 digest 去比，结论随机。
 */
export function findModelDigest(details: ReadonlyArray<NamedModel>, model: string): string {
  const exact = details.find((m) => m.name === model)
  if (exact) return exact.digest
  const family = details.find((m) => m.name.split(':')[0] === model.split(':')[0])
  return family?.digest ?? ''
}

/**
 * 判定"这条结论还作数吗"。三个不许：
 *  - 云端 provider 拿不到镜像摘要 ⇒ 没有失效键，不许说过期（只能重探）；
 *  - 本地但当前取不到摘要（serve 没起 / 模型已删）⇒ 同样不许说过期，那是"无法核对"；
 *  - 只有取到摘要且与探测时不同，才判 stale。
 */
export function isDelegateEntryStale(
  entry: { providerId: string; model: string; digest: string },
  localProviderIds: ReadonlySet<string>,
  details: ReadonlyArray<NamedModel>
): boolean {
  if (!localProviderIds.has(entry.providerId) || !entry.digest) return false
  const current = findModelDigest(details, entry.model)
  if (!current) return false
  return current !== entry.digest
}

