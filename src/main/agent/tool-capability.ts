// 工具调用能力探针（P0-4b）——问一句"这台模型会不会发起原生工具调用"，把答案落在库里
//
// 与委派探针（delegate-capability）同构，但**结论分开存**：
//   · 委派判的是"派得出活吗"（要 role/task），工具判的是"调得动工具吗"（一个必填参数的简单工具）；
//   · 一台模型可能调得动简单工具却不会派活，反过来也不成立 ⇒ 两个结论不能互相顶替。
//
// 三条硬规矩（与委派探针同源，理由见 shared/tool-capability.ts 文件头）：
//  ① 只探原生 tools 路径；② 请求失败/超时/鉴权失败一律不下结论、不覆盖旧判定；
//  ③ 端点**明确拒绝 tools** 是确定性事实 ⇒ 落 known_unusable，界面据此说"这台不会调工具"。
//
// 费用：每次探测默认 3 发真请求，走用户自己的 Key。这是产品已拍板的口径，界面必须写明。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { providerManager } from '../providers/manager'
import { providerRepo } from '../db/repositories/provider.repo'
import { ProviderError } from '../providers/types'
import { ollamaRuntime } from '../ollama/ollama-runtime'
import { errMsg } from '../error'
import { createLogger } from '../logger'
import { isToolsUnsupportedError } from '../../shared/text-tool-protocol'
import {
  MIN_TOOL_PROBE_RUNS,
  TOOL_PROBE,
  findToolModelDigest,
  isToolEntryStale,
  judgeToolProbe,
  normalizeToolEntries,
  replyToToolProbeSample,
  skippedToolEntry,
  toolCapabilityKey,
  unknownToolEntry,
  type ToolCapabilityEntry,
  type ToolCapabilityView,
  type ToolProbeFailure,
  type ToolProbeReason,
  type ToolProbeReply,
  type ToolProbeResult
} from '../../shared/tool-capability'
import type { ToolSchema } from '../../shared/types'

const log = createLogger('tool-capability')

const K_TOOL_CAPABILITY = 'agent.tool_capability'

/** 探针工具：一个纯虚拟的"查一下"工具。它不进注册表、不可执行，只用来观察模型会不会发起结构化调用 */
const PROBE_TOOL: ToolSchema = {
  id: `probe:${TOOL_PROBE.toolName}`,
  name: TOOL_PROBE.toolName,
  description: '查询本地资料库。必须调用本工具，不要直接作答。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要查询的内容（必填，例如 POCKETAI-TOOL-PROBE）' }
    },
    required: [TOOL_PROBE.argName]
  },
  permission: 'deny',
  source: 'builtin'
}

/** 读已存的判定结果（脏 JSON 一律当空，不抛） */
export function listToolCapabilities(): ToolCapabilityEntry[] {
  const raw = appConfigRepo.get(K_TOOL_CAPABILITY)
  if (!raw) return []
  try {
    return normalizeToolEntries(JSON.parse(raw))
  } catch {
    return []
  }
}

function saveEntry(entry: ToolCapabilityEntry): void {
  const next = listToolCapabilities().filter((e) => e.key !== entry.key)
  next.push(entry)
  // 新的排前面，容量兜底（与文本协议/委派判定同构：单键 JSON 数组，不建新表）
  next.sort((a, b) => b.checkedAt - a.checkedAt)
  appConfigRepo.set(K_TOOL_CAPABILITY, JSON.stringify(normalizeToolEntries(next)))
}

/** 本地 ollama 才有镜像摘要可当失效键；云端拿不到就留空（不猜） */
async function digestOfModel(providerId: string, model: string): Promise<string> {
  try {
    const record = providerRepo.get(providerId)
    if (record?.type !== 'ollama') return ''
    return findToolModelDigest(await ollamaRuntime.listModelDetails(), model)
  } catch (e) {
    log.warn(`取模型 digest 失败（不影响判定，只是没有失效键）: ${errMsg(e)}`)
    return ''
  }
}

/**
 * 单发请求"已经在飞"的时间上限。与委派探针同一档（60 秒）：
 * 本机 3b 实测每发≈6.7 秒，云端 1~10 秒；没有上限时端点收了连接不回话等于永远挂着。
 * 计时从**排到槽之后**起算（onSlotStart），排队不算"这台不回话"。
 */
const PROBE_SAMPLE_TIMEOUT_MS_DEFAULT = 60_000
let probeSampleTimeoutMs = PROBE_SAMPLE_TIMEOUT_MS_DEFAULT

/** 测试缝：CI 不该真等 60 秒。生产代码不许调 */
export function setToolProbeSampleTimeoutForTest(ms: number | null): void {
  probeSampleTimeoutMs = ms ?? PROBE_SAMPLE_TIMEOUT_MS_DEFAULT
}

export function currentToolProbeSampleTimeoutMs(): number {
  return probeSampleTimeoutMs
}

/** 正在探的台子：key → 那一发的中止器（用户停止 + 同一台不叠两发） */
const runningProbes = new Map<string, AbortController>()

/** 用户点「停止」：中止那一发（不下结论、也不改写此前判定）。返回是不是真有一发在探 */
export function abortToolProbe(providerId: string, model: string): boolean {
  const ctl = runningProbes.get(toolCapabilityKey(providerId, model))
  if (!ctl) return false
  ctl.abort()
  return true
}

/**
 * 把一次请求失败分成"和模型能力无关"的三类。
 * 401/403 = 鉴权失败；没有 status 或 5xx = 连不上/服务端出错；其余（400/404/429…）归"请求出错"。
 * 三类都不落库：把它们写成"不会调工具"就是把"没配好 Key"演成"这台模型不行"。
 */
function classifyError(e: unknown): 'auth' | 'network' | 'other' {
  if (!(e instanceof ProviderError)) return 'network'
  if (e.status === 401 || e.status === 403) return 'auth'
  if (e.status === undefined || e.status >= 500) return 'network'
  return 'other'
}

/**
 * 探一台模型一次（默认 3 发）。串行是刻意的：并发会把同一台本地模型一次打满。
 */
export async function probeToolCapability(
  providerId: string,
  model: string,
  runs: number = MIN_TOOL_PROBE_RUNS
): Promise<ToolProbeResult> {
  const key = toolCapabilityKey(providerId, model)
  if (runningProbes.has(key)) {
    log.warn(`拒探 ${key}：这一台已经有一发在探，两发叠在同一台模型上只会互相拖慢`)
    return { entry: unknownToolEntry(providerId, model, 'no_samples'), error: { code: 'probe_running' } }
  }

  const adapter = providerManager.getAdapter(providerId)
  const total = Math.min(10, Math.max(1, Math.round(runs)))
  const samples: ToolProbeReply[] = []
  let authFailures = 0
  let networkFailures = 0
  let otherFailures = 0
  let toolRejections = 0
  let timeouts = 0
  let abortedByUser = false

  const outer = new AbortController()
  runningProbes.set(key, outer)
  try {
    for (let i = 0; i < total; i++) {
      // 每一发一把独立的中止器：超时或用户停止都只掐这一发
      const ctl = new AbortController()
      const relay = (): void => ctl.abort()
      outer.signal.addEventListener('abort', relay, { once: true })
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await adapter.streamChat(
          [
            { role: 'system', content: TOOL_PROBE.systemPrompt },
            { role: 'user', content: TOOL_PROBE.userPrompt }
          ],
          {
            model,
            temperature: 0,
            maxTokens: 220,
            tools: [PROBE_TOOL],
            toolChoice: 'auto',
            signal: ctl.signal,
            onSlotStart: () => {
              timer = setTimeout(() => {
                timedOut = true
                ctl.abort()
              }, probeSampleTimeoutMs)
              timer.unref?.()
            }
          },
          { onDelta: () => {} }
        )
        samples.push(
          replyToToolProbeSample({
            content: result.content ?? '',
            toolCalls: (result.toolCalls ?? []).map((c) => ({
              name: c.function.name,
              arguments: c.function.arguments
            }))
          })
        )
      } catch (e) {
        if (outer.signal.aborted) {
          // 用户点的「停止」：整探就此收住（也不落库）
          abortedByUser = true
          log.warn(`工具探针被用户中止 ${key}：已跑完 ${samples.length}/${total} 发 ⇒ 不下结论`)
          break
        }
        if (timedOut) {
          timeouts++
          log.warn(`工具探针第 ${i + 1} 发在飞 ${probeSampleTimeoutMs}ms 仍没回音 ⇒ 中止这一发并停止后续`)
          break
        }
        if (isToolsUnsupportedError(errMsg(e))) {
          // 端点明确拒绝 tools：这是确定性事实，不用再问后面两发
          toolRejections++
          log.warn(`工具探针第 ${i + 1} 发被端点以"不支持 tools"拒绝 ⇒ 判 known_unusable`)
          break
        }
        const kind = classifyError(e)
        if (kind === 'auth') {
          authFailures++
          log.warn(`工具探针第 ${i + 1} 发鉴权失败（401/403）⇒ 停止后续，不下结论`)
          break
        }
        if (kind === 'network') networkFailures++
        else otherFailures++
        log.warn(`工具探针第 ${i + 1} 次失败（${kind}）: ${errMsg(e)}`)
      } finally {
        if (timer) clearTimeout(timer)
        outer.signal.removeEventListener('abort', relay)
      }
    }
  } finally {
    runningProbes.delete(key)
  }

  // 失败面优先：任何"和模型能力无关"的失败都不落库（口径同委派探针）
  let failure: ToolProbeFailure | null = null
  if (abortedByUser) failure = { code: 'probe_aborted' }
  else if (timeouts > 0) {
    failure = {
      code: 'probe_timeout',
      params: { failed: timeouts, total, sec: Math.round(probeSampleTimeoutMs / 1000) }
    }
  } else if (authFailures > 0) failure = { code: 'auth_failed' }
  else if (networkFailures > 0) failure = { code: 'network_failed' }
  else if (otherFailures > 0) {
    failure = { code: 'probe_incomplete', params: { failed: otherFailures, total } }
  }
  if (failure) {
    log.warn(`工具探测未跑完 ${key}：${failure.code}（已成功 ${samples.length}/${total}）⇒ 保留此前的判定`)
    return {
      entry: unknownToolEntry(providerId, model, failure.code === 'probe_aborted' ? 'no_samples' : 'some_requests_failed'),
      error: failure
    }
  }

  // 明确拒绝 tools：确定性事实，落 known_unusable（唯一会因"失败"落库的分支）
  if (toolRejections > 0 && samples.length === 0) {
    const entry: ToolCapabilityEntry = {
      key,
      providerId,
      model,
      tier: 'known_unusable',
      reason: 'tools_rejected',
      samples: 0,
      nativeHits: 0,
      fenceHits: 0,
      digest: await digestOfModel(providerId, model),
      checkedAt: Date.now()
    }
    saveEntry(entry)
    return { entry, error: null }
  }
  // 同一轮里既有成功又有"拒绝 tools"：端点行为不一致，不据此下任何结论
  if (toolRejections > 0) {
    log.warn(`工具探针 ${key} 同一轮里既有成功又有拒绝（${toolRejections} 次）⇒ 不落库`)
    return {
      entry: unknownToolEntry(providerId, model, 'some_requests_failed'),
      error: { code: 'probe_incomplete', params: { failed: toolRejections, total } }
    }
  }

  const judged = judgeToolProbe(samples)
  if (judged.tier === 'unknown') {
    // 有效样本不足：不下结论，也不写 unknown 覆盖旧判定
    const reason: ToolProbeReason = judged.reason ?? 'insufficient_runs'
    log.warn(`工具探针 ${key} 没拿到足够样本（${samples.length}/${total}）：${reason} ⇒ 不落库`)
    return {
      entry: unknownToolEntry(providerId, model, reason),
      error: { code: 'probe_incomplete', params: { failed: total - samples.length, total } }
    }
  }

  const entry: ToolCapabilityEntry = {
    key,
    providerId,
    model,
    tier: judged.tier,
    reason: judged.reason ?? '',
    samples: judged.samples,
    nativeHits: judged.nativeHits,
    fenceHits: judged.fenceHits,
    digest: await digestOfModel(providerId, model),
    checkedAt: Date.now()
  }
  saveEntry(entry)
  return { entry, error: null }
}

/**
 * 用户点「跳过检测」：写一条 unknown/user_skipped。
 * 与探测共用同一份台账，自动探测据此不再重复问；不是"判定为不会"，所以档位仍是未检测。
 */
export function skipToolProbe(providerId: string, model: string): ToolCapabilityEntry {
  // 与探测同一条存在性校验：不给"已经不存在的服务商"留下垃圾条目
  providerManager.getAdapter(providerId)
  const entry = skippedToolEntry(providerId, model)
  saveEntry(entry)
  return entry
}

/**
 * 端点明确拒绝 tools（引擎 400 分支）：这是确定性事实，落 known_unusable/tools_rejected。
 * 与探针的 400 分支同一口径——唯一会因"失败"落库的一条路。
 * 不抛错：引擎那一路正处在失败接管里，判定写不进去不能反过来把本轮再炸一次。
 */
export async function recordToolsRejected(providerId: string, model: string): Promise<void> {
  if (!providerId || !model) return
  try {
    const entry: ToolCapabilityEntry = {
      key: toolCapabilityKey(providerId, model),
      providerId,
      model,
      tier: 'known_unusable',
      reason: 'tools_rejected',
      samples: 0,
      nativeHits: 0,
      fenceHits: 0,
      digest: await digestOfModel(providerId, model),
      checkedAt: Date.now()
    }
    saveEntry(entry)
  } catch (e) {
    log.warn(`记录 tools 被拒失败（不影响本轮失败接管）: ${errMsg(e)}`)
  }
}

/**
 * 成功工具步的正向观察：这一轮它**真的**发起了原生 tool_calls 且执行出结果。
 * 只累加计数据，不凭单次观察下"不会"的结论：
 *  · 累计到 3 次原生命中 ⇒ usable；
 *  · 不足 3 次 ⇒ likely_unusable/partial_native_calls（与判卷同一口径，不把"偶尔会"写成"会"）。
 * 运行期观察不是探针，不重置 samples；计数据封顶 99（normalize 同一档）。
 */
export async function recordNativeToolCallObservation(providerId: string, model: string): Promise<void> {
  if (!providerId || !model) return
  try {
    const key = toolCapabilityKey(providerId, model)
    const prev = listToolCapabilities().find((e) => e.key === key)
    const nativeHits = Math.min(99, (prev?.nativeHits ?? 0) + 1)
    const samples = Math.min(99, (prev?.samples ?? 0) + 1)
    const entry: ToolCapabilityEntry = {
      key,
      providerId,
      model,
      tier: nativeHits >= MIN_TOOL_PROBE_RUNS ? 'usable' : 'likely_unusable',
      reason: nativeHits >= MIN_TOOL_PROBE_RUNS ? '' : 'partial_native_calls',
      samples,
      nativeHits,
      fenceHits: prev?.fenceHits ?? 0,
      digest: await digestOfModel(providerId, model),
      checkedAt: Date.now()
    }
    saveEntry(entry)
  } catch (e) {
    log.warn(`记录原生工具调用观察失败（不影响本轮）: ${errMsg(e)}`)
  }
}

/** 给界面用：附上"这台模型的判定是否已过期"（只有拿得到 digest 的本地模型能判） */
export async function listToolCapabilitiesWithStaleness(): Promise<ToolCapabilityView[]> {
  const entries = listToolCapabilities()
  if (entries.length === 0) return []
  const localProviders = new Set(providerRepo.list().filter((p) => p.type === 'ollama').map((p) => p.id))
  let details: Awaited<ReturnType<typeof ollamaRuntime.listModelDetails>> = []
  const needsDigest = entries.some((e) => localProviders.has(e.providerId) && e.digest)
  if (needsDigest) {
    try {
      details = await ollamaRuntime.listModelDetails()
    } catch {
      details = []
    }
  }
  return entries.map((e) => ({
    ...e,
    stale: isToolEntryStale(e, localProviders, details)
  }))
}

export const __toolProbeToolForTest = PROBE_TOOL
