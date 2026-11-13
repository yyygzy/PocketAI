// 工具调用能力判定（P0-4b）——纯函数，零依赖
//
// 与委派能力（delegate-capability）是两件事：
//   · 委派问的是「这台模型当得了中心管控者吗」（要 role/task 参数，判卷看 3/3 原生调用）；
//   · 这里问的是「这台模型会不会发起工具调用」——更基础的一问，模型可能调得动简单工具却派不了活。
// 两者共用同一套探针传输与存储形状，但**结论不许互相顶替**：一个键一个 JSON 命名空间。
//
// 三条硬规矩：
//  ① 只认原生 tools 路径：文本协议实测 0/3，拿它当"会调工具"的结论是反的。
//  ② 请求失败 ≠ 不会调：网络/鉴权/超时一律 unknown，且不覆盖此前判定。
//     唯一的例外是端点**明确拒绝 tools 参数**——那是确定性事实，判 known_unusable。
//  ③ 四档而不是三档：必须留得下"没测出来"，否则连不上会被演成"这台不行"。
//
// 为什么住 shared 且零依赖：发起请求那部分要碰 providerManager/logger（electron 链），
// 判卷必须能脱离它们被逐条断言（同 V4-Iter-123 的教训）。

/** 四档：未检测 / 可用 / 可能不可用 / 已知不可用 */
export type ToolCapabilityTier = 'unknown' | 'usable' | 'likely_unusable' | 'known_unusable'

/**
 * 结论/诊断的原因码。`unknown` 与不可用两档都可能带它，界面据此说清"为什么"。
 * 不用句子：这条链的终点是四语界面（口径同 V4-Iter-152）。
 */
export type ToolProbeReason =
  | 'no_samples'
  | 'some_requests_failed'
  | 'insufficient_runs'
  | 'partial_native_calls'
  | 'no_native_call'
  | 'fence_only'
  | 'tools_rejected'
  | 'user_skipped'

/** 探针用的假工具：只考察"会不会发起原生调用"，不碰任何真工具，也不产生副作用 */
export const TOOL_PROBE_TOOL = 'tool_probe'

/** 少于这个次数不出结论（单发抖动不足以定论；与委派探针同一档） */
export const MIN_TOOL_PROBE_RUNS = 3

export interface ToolProbeReply {
  /** 一次请求是否成功拿到回复（失败 ⇒ 不参与判卷） */
  ok: boolean
  /** 原生 tool_calls 里有没有对探针工具的合法调用 */
  nativeCall: boolean
  /** 正文里有没有"围栏 + {name, arguments}"形状（含 ```json 这类错标签） */
  fencedCall: boolean
}

export interface ToolProbeJudgement {
  tier: ToolCapabilityTier
  /** 参与判卷的样本数 */
  samples: number
  nativeHits: number
  fenceHits: number
  /** tier = unknown 时必有原因码；其余档在"有诊断价值"时也带 */
  reason?: ToolProbeReason
}

/**
 * 判一轮探针。规则写死在这里，别散到调用方：
 *  - 无样本 / 有失败 / 有效样本不足 ⇒ unknown（失败不是证据）
 *  - 每一次都发出合法原生调用 ⇒ usable
 *  - 一次原生调用都没有、但有过围栏形状 ⇒ known_unusable（当前引擎解析不了，别写成"勉强可用"）
 *  - 一次原生调用都没有 ⇒ known_unusable
 *  - 部分命中 ⇒ likely_unusable（能调，但不稳；交给界面按"可能"说）
 */
export function judgeToolProbe(replies: ToolProbeReply[]): ToolProbeJudgement {
  const samples = replies.length
  if (samples === 0) {
    return { tier: 'unknown', samples: 0, nativeHits: 0, fenceHits: 0, reason: 'no_samples' }
  }
  const failed = replies.filter((r) => !r.ok).length
  if (failed > 0) {
    return {
      tier: 'unknown',
      samples,
      nativeHits: replies.filter((r) => r.nativeCall).length,
      fenceHits: replies.filter((r) => r.fencedCall && !r.nativeCall).length,
      reason: 'some_requests_failed'
    }
  }
  if (samples < MIN_TOOL_PROBE_RUNS) {
    return {
      tier: 'unknown',
      samples,
      nativeHits: replies.filter((r) => r.nativeCall).length,
      fenceHits: replies.filter((r) => r.fencedCall && !r.nativeCall).length,
      reason: 'insufficient_runs'
    }
  }
  const nativeHits = replies.filter((r) => r.nativeCall).length
  const fenceHits = replies.filter((r) => r.fencedCall && !r.nativeCall).length
  if (nativeHits === samples) return { tier: 'usable', samples, nativeHits, fenceHits }
  if (nativeHits === 0 && fenceHits > 0) {
    return { tier: 'known_unusable', samples, nativeHits, fenceHits, reason: 'fence_only' }
  }
  if (nativeHits === 0) {
    return { tier: 'known_unusable', samples, nativeHits, fenceHits, reason: 'no_native_call' }
  }
  return { tier: 'likely_unusable', samples, nativeHits, fenceHits, reason: 'partial_native_calls' }
}

// ---------- 探针请求体（发出去的形状与判卷口径必须同源） ----------

export interface ToolProbeRequestShape {
  systemPrompt: string
  userPrompt: string
  toolName: string
  /** 必填参数名；构造 tools schema 与校验参数都用它，防两处漂移 */
  argName: string
  minArgChars: number
}

export const TOOL_PROBE: ToolProbeRequestShape = {
  systemPrompt: '你是工具型助手。你必须调用工具取得信息，禁止用自然语言直接回答。',
  userPrompt: '查一下自检标记 POCKETAI-TOOL-PROBE 对应哪条说明。不要直接回答，必须先调用工具。',
  toolName: TOOL_PROBE_TOOL,
  argName: 'query',
  minArgChars: 1
}

/** arguments 是否是一次合法工具调用（必填参数存在且非空） */
export function isLegalToolProbeArgs(args: unknown, shape: ToolProbeRequestShape = TOOL_PROBE): boolean {
  if (typeof args !== 'object' || args === null) return false
  const rec = args as Record<string, unknown>
  const value = rec[shape.argName]
  if (typeof value !== 'string') return false
  return value.trim().length >= shape.minArgChars
}

/** 文本里是否存在"围栏 + {name: 探针工具, arguments: {...}}"的形状（诊断用） */
export function hasFencedToolCall(text: string, toolName: string = TOOL_PROBE_TOOL): boolean {
  const blocks = [...String(text ?? '').matchAll(/```[a-zA-Z_\-*]*[ \t]*\r?\n?([\s\S]*?)```/g)]
  for (const b of blocks) {
    try {
      const obj = JSON.parse(String(b[1] ?? '')) as Record<string, unknown>
      if (obj?.name !== toolName) continue
      const args = obj.arguments
      if (typeof args === 'object' && args !== null) return true
    } catch {
      // 不是 JSON 的围栏块（示例代码等）跳过：宁可漏判，也不把普通代码块当调用
      continue
    }
  }
  return false
}

/** 从一次流式回复里抽出探针判据。原生 tool_calls 优先 */
export function replyToToolProbeSample(input: {
  content: string
  toolCalls?: Array<{ name: string; arguments: string }> | null
  requestOk?: boolean
}): ToolProbeReply {
  if (input.requestOk === false) return { ok: false, nativeCall: false, fencedCall: false }
  const calls = input.toolCalls ?? []
  const nativeCall = calls.some((c) => {
    if (c.name !== TOOL_PROBE.toolName) return false
    try {
      return isLegalToolProbeArgs(JSON.parse(c.arguments || '{}'))
    } catch {
      return false
    }
  })
  return { ok: true, nativeCall, fencedCall: !nativeCall && hasFencedToolCall(input.content) }
}

// ---------- 存储 ----------

export interface ToolCapabilityEntry {
  /** `providerId::model`，与文本协议/委派判定同一个键形状 */
  key: string
  providerId: string
  model: string
  tier: ToolCapabilityTier
  /** 判卷/诊断原因；'' = 没有必要解释（如 3/3 可用） */
  reason: ToolProbeReason | ''
  /** 判卷时的样本数与命中数：界面要说"2/3"而不是凭空断言 */
  samples: number
  nativeHits: number
  fenceHits: number
  /** 本地模型的镜像摘要；云端为空 ⇒ 无失效键，只能重探 */
  digest: string
  checkedAt: number
}

export interface ToolCapabilityView extends ToolCapabilityEntry {
  stale: boolean
}

/** 探针本身没跑完的失败码（与"判定"分开：界面不许把失败读成"这台不行"） */
export type ToolProbeFailureCode =
  | 'probe_incomplete'
  | 'probe_timeout'
  | 'probe_aborted'
  | 'probe_running'
  | 'auth_failed'
  | 'network_failed'

export interface ToolProbeFailure {
  code: ToolProbeFailureCode
  /** 只放数与枚举值（界面插进自己的文案里），不许放整句中文 */
  params?: Record<string, string | number>
}

export interface ToolProbeResult {
  entry: ToolCapabilityEntry
  error: ToolProbeFailure | null
}

/** 码 → 文案：一律静态字面量 `t('…')`，不做 `t(变量)`（仓库硬规矩：动态 key 不许新增） */
type TFn = (key: string, params?: Record<string, string | number>) => string

const TIER_TEXT: Record<ToolCapabilityTier, (t: TFn) => string> = {
  unknown: (t) => t('provider.toolCapUnknown'),
  usable: (t) => t('provider.toolCapUsable'),
  likely_unusable: (t) => t('provider.toolCapLikely'),
  known_unusable: (t) => t('provider.toolCapKnown')
}

/** 四档 → 当前语言的一句话（设置页与后续对话提示共用一处，别两处各写一套） */
export function toolTierText(t: TFn, tier: ToolCapabilityTier): string {
  return TIER_TEXT[tier](t)
}

const REASON_TEXT: Record<
  ToolProbeReason,
  (t: TFn, e: { nativeHits: number; samples: number }) => string
> = {
  no_samples: (t) => t('toolCap.reason.noSamples'),
  some_requests_failed: (t) => t('toolCap.reason.someRequestsFailed'),
  insufficient_runs: (t) => t('toolCap.reason.insufficientRuns'),
  partial_native_calls: (t, e) => t('toolCap.reason.partial', { hits: e.nativeHits, samples: e.samples }),
  no_native_call: (t, e) => t('toolCap.reason.noCall', { samples: e.samples }),
  fence_only: (t) => t('toolCap.reason.fence'),
  tools_rejected: (t) => t('toolCap.reason.rejected'),
  user_skipped: (t) => t('toolCap.reason.skipped')
}

/** 原因码 → 解释文案（无原因返回空串；未知码也只当没有原因，绝不回落中文句子） */
export function toolReasonText(
  t: TFn,
  entry: { reason: ToolProbeReason | ''; nativeHits: number; samples: number }
): string {
  if (!entry.reason) return ''
  return REASON_TEXT[entry.reason](t, entry)
}

const numParam = (params: Record<string, string | number>, key: string): number =>
  typeof params[key] === 'number' ? (params[key] as number) : 0

const FAILURE_TEXT: Record<ToolProbeFailureCode, (t: TFn, p: Record<string, string | number>) => string> = {
  probe_incomplete: (t, p) => t('toolCap.failIncomplete', { failed: numParam(p, 'failed'), total: numParam(p, 'total') }),
  probe_timeout: (t, p) =>
    t('toolCap.failTimeout', {
      failed: numParam(p, 'failed'),
      total: numParam(p, 'total'),
      sec: numParam(p, 'sec')
    }),
  probe_aborted: (t) => t('toolCap.failAborted'),
  probe_running: (t) => t('toolCap.failRunning'),
  auth_failed: (t) => t('toolCap.failAuth'),
  network_failed: (t) => t('toolCap.failNetwork')
}

/** 把码翻成当前界面的那句话（未知码 ⇒ 回落通用文案） */
export function toolFailureText(
  t: TFn,
  failure: ToolProbeFailure | null | undefined,
  fallback: string
): string {
  if (!failure) return fallback
  const fn = FAILURE_TEXT[failure.code]
  return fn ? fn(t, failure.params ?? {}) : fallback
}

export const MAX_TOOL_CAP_ENTRIES = 200
const TIERS: ToolCapabilityTier[] = ['unknown', 'usable', 'likely_unusable', 'known_unusable']
const REASONS: ToolProbeReason[] = [
  'no_samples',
  'some_requests_failed',
  'insufficient_runs',
  'partial_native_calls',
  'no_native_call',
  'fence_only',
  'tools_rejected',
  'user_skipped'
]
const MAX_PART_CHARS = 200

/** 清洗落盘内容：脏项整条丢掉（不给默认值，免得把"没测过"写成"不会"） */
export function normalizeToolEntries(raw: unknown): ToolCapabilityEntry[] {
  if (!Array.isArray(raw)) return []
  const out: ToolCapabilityEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const providerId = typeof rec.providerId === 'string' ? rec.providerId.trim() : ''
    const model = typeof rec.model === 'string' ? rec.model.trim() : ''
    if (!providerId || !model) continue
    if (providerId.length > MAX_PART_CHARS || model.length > MAX_PART_CHARS) continue
    const tier = TIERS.includes(rec.tier as ToolCapabilityTier) ? (rec.tier as ToolCapabilityTier) : null
    if (!tier) continue
    const key = toolCapabilityKey(providerId, model)
    if (seen.has(key)) continue
    seen.add(key)
    const asInt = (v: unknown, max: number): number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.min(Math.round(v), max) : 0
    out.push({
      key,
      providerId,
      model,
      tier,
      reason: REASONS.includes(rec.reason as ToolProbeReason) ? (rec.reason as ToolProbeReason) : '',
      samples: asInt(rec.samples, 99),
      nativeHits: asInt(rec.nativeHits, 99),
      fenceHits: asInt(rec.fenceHits, 99),
      digest: typeof rec.digest === 'string' ? rec.digest.slice(0, 128) : '',
      checkedAt: asInt(rec.checkedAt, Number.MAX_SAFE_INTEGER)
    })
  }
  return out.slice(0, MAX_TOOL_CAP_ENTRIES)
}

/** 键形状与文本协议/委派判定一致（`providerId::model`），别各自拼 */
export function toolCapabilityKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

interface NamedModel {
  name: string
  digest: string
}

/** 在 tags 清单里找这条模型现在的镜像；同名优先，避免 3b/7b 混用摘要 */
export function findToolModelDigest(details: ReadonlyArray<NamedModel>, model: string): string {
  const exact = details.find((m) => m.name === model)
  if (exact) return exact.digest
  const family = details.find((m) => m.name.split(':')[0] === model.split(':')[0])
  return family?.digest ?? ''
}

/**
 * 判定"这条结论还作数吗"。三个不许：
 *  - 云端 provider 拿不到镜像摘要 ⇒ 没有失效键，不许说过期；
 *  - 本地但当前取不到摘要 ⇒ 那是"无法核对"，也不许说过期；
 *  - 只有取到摘要且与探测时不同，才判 stale。
 */
export function isToolEntryStale(
  entry: { providerId: string; model: string; digest: string },
  localProviderIds: ReadonlySet<string>,
  details: ReadonlyArray<NamedModel>
): boolean {
  if (!localProviderIds.has(entry.providerId) || !entry.digest) return false
  const current = findToolModelDigest(details, entry.model)
  if (!current) return false
  return current !== entry.digest
}

/** 用户点了「跳过这次检测」：写一条 unknown + user_skipped，自动探测就不再重复问 */
export function skippedToolEntry(providerId: string, model: string): ToolCapabilityEntry {
  return {
    key: toolCapabilityKey(providerId, model),
    providerId,
    model,
    tier: 'unknown',
    reason: 'user_skipped',
    samples: 0,
    nativeHits: 0,
    fenceHits: 0,
    digest: '',
    checkedAt: Date.now()
  }
}

/** 探针没跑完时回给界面的占位判定（不落库） */
export function unknownToolEntry(providerId: string, model: string, reason: ToolProbeReason): ToolCapabilityEntry {
  return {
    key: toolCapabilityKey(providerId, model),
    providerId,
    model,
    tier: 'unknown',
    reason,
    samples: 0,
    nativeHits: 0,
    fenceHits: 0,
    digest: '',
    checkedAt: Date.now()
  }
}
