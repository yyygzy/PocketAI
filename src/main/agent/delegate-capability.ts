// 委派能力探针（V4-Iter-142）——问一句"这台模型当得了中心管控者吗"，把答案落在库里
//
// 三条硬规矩，全都来自本批之前的实测，不是风格：
//  ① **只探原生 tools 路径**。M8：同一批模型改走"把协议写进提示词"后全部 0/3，连 3b 都从
//     "4/4 会派活"退化成"自己写汇报"。所以被判成"走文本协议"的模型**直接拒探** ——
//     拿文本协议的结果当能力结论是反的（会让人以为这台不行）。
//  ② **请求失败 ≠ 不派活**。任何一次请求出错就出 unknown，绝不落成 no_delegation；
//     一次网络抖动不该把一台能干的模型标成不能用（同 V4-Iter-139 那条"失败被当成功"的反向错法）。
//  ③ **digest 是失效键**。本地模型的镜像内容换了（同名不同 digest）⇒ 旧结论标 stale，
//     界面必须区分"没探过 / 探过但过期 / 探过且新鲜"。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { providerManager } from '../providers/manager'
import { providerRepo } from '../db/repositories/provider.repo'
import { ollamaRuntime } from '../ollama/ollama-runtime'
import { errMsg } from '../error'
import { createLogger } from '../logger'
import { isTextProtocolForced } from './text-protocol-prefs'
import { addOrRemoveDelegationEnabled, listDelegationEnabledModels } from './delegate-prefs'
import {
  DELEGATE_PROBE,
  MIN_PROBE_RUNS,
  delegateKey,
  findModelDigest,
  isDelegateEntryStale,
  judgeDelegateProbe,
  normalizeDelegateEntries,
  replyToProbeSample,
  type DelegateCapabilityView,
  type DelegateFailure,
  type DelegateProbeResult,
  type DelegateCapabilityEntry,
  type ProbeReply
} from '../../shared/delegate-capability'
import type { ToolSchema } from '../../shared/types'

const log = createLogger('delegate-capability')

const K_DELEGATE_CAPABILITY = 'agent.delegate_capability'

/** 探针工具：一个纯虚拟的"派活"工具。它不进注册表、不可执行，只用来观察模型会不会发起结构化委派 */
const PROBE_TOOL: ToolSchema = {
  id: `probe:${DELEGATE_PROBE.toolName}`,
  name: DELEGATE_PROBE.toolName,
  description: '把一项工作委派给指定角色的子代理执行。必须调用本工具，不要自己作答。',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', enum: [...DELEGATE_PROBE.roles], description: '子代理角色' },
      task: { type: 'string', description: '交给该角色的完整任务描述（一句话说清要什么）' }
    },
    required: ['role', 'task']
  },
  permission: 'deny',
  source: 'builtin'
}

// 返回形状住在 shared（preload 与渲染层都要看得到），这里只复用
export type ProbeOutcome = DelegateProbeResult

/** 读已存的判定结果（脏 JSON 一律当空，不抛） */
export function listDelegateCapabilities(): DelegateCapabilityEntry[] {
  const raw = appConfigRepo.get(K_DELEGATE_CAPABILITY)
  if (!raw) return []
  try {
    return normalizeDelegateEntries(JSON.parse(raw))
  } catch {
    return []
  }
}

function saveEntry(entry: DelegateCapabilityEntry): void {
  const next = listDelegateCapabilities().filter((e) => e.key !== entry.key)
  next.push(entry)
  // 新的排前面，容量兜底（与文本协议那份开关同构：单键 JSON 数组，不建新表）
  next.sort((a, b) => b.checkedAt - a.checkedAt)
  appConfigRepo.set(K_DELEGATE_CAPABILITY, JSON.stringify(normalizeDelegateEntries(next)))
}

/** 本地 ollama 才有镜像摘要可当失效键；云端拿不到就留空（不猜） */
async function digestOfModel(providerId: string, model: string): Promise<string> {
  try {
    const record = providerRepo.get(providerId)
    if (record?.type !== 'ollama') return ''
    return findModelDigest(await ollamaRuntime.listModelDetails(), model)
  } catch (e) {
    log.warn(`取模型 digest 失败（不影响判定，只是没有失效键）: ${errMsg(e)}`)
    return ''
  }
}

/**
 * 单发请求"已经在飞"的时间上限。取值理由（不是拍的）：本机 3b 实测探针 3 发 20.1 秒≈每发 6.7 秒（含冷启动），
 * 云端一般 1~10 秒 ⇒ 60 秒是"慢近十倍也等得住"的余量；而没有这个上限时，端点收了连接不回话就等于**永远挂着**
 * （2026-10-21 真机第二次那两发探针，各自挂了 7 分钟以上、日志里连一条失败都没有）。
 */
const PROBE_SAMPLE_TIMEOUT_MS_DEFAULT = 60_000
let probeSampleTimeoutMs = PROBE_SAMPLE_TIMEOUT_MS_DEFAULT

/** 测试缝：CI 不该真等 60 秒。生产代码不许调（与 local-slot 那几条缝同一个理由） */
export function setProbeSampleTimeoutForTest(ms: number | null): void {
  probeSampleTimeoutMs = ms ?? PROBE_SAMPLE_TIMEOUT_MS_DEFAULT
}

/** 现在生效的是多少毫秒（用例拿它断"缝真的接上了"，而不是设了个没人读的数） */
export function currentProbeSampleTimeoutMs(): number {
  return probeSampleTimeoutMs
}

/**
 * 正在探的台子：key → 那一发的中止器。
 * 两件事共用它：① 用户点「停止探针」；② 同一台不许叠两发（§244 真机那次就是两发叠在同一台上，
 * 结果两发一起挂——上一发不会被发现，下一发也永远排不到）。
 */
const runningProbes = new Map<string, AbortController>()

/** 用户点「停止探针」：中止那一发（不下结论、也不改写此前判定）。返回是不是真有一发在探 */
export function abortDelegateProbe(providerId: string, model: string): boolean {
  const ctl = runningProbes.get(delegateKey(providerId, model))
  if (!ctl) return false
  ctl.abort()
  return true
}

function unknownEntry(providerId: string, model: string): DelegateCapabilityEntry {
  return {
    key: delegateKey(providerId, model),
    providerId,
    model,
    capability: 'unknown',
    samples: 0,
    nativeHits: 0,
    digest: '',
    checkedAt: Date.now()
  }
}

/**
 * 探一台模型一次（默认 3 发）。串行是刻意的：并发会把同一台本地模型一次打满，
 * 而探针本身跑在用户的显存上（V4-Iter-141 的槽位会排队，这里不再叠一层并发）。
 */
export async function probeDelegateCapability(
  providerId: string,
  model: string,
  runs: number = MIN_PROBE_RUNS
): Promise<ProbeOutcome> {
  if (isTextProtocolForced(providerId, model)) {
    // 界面要的是码不是中文句子（V4-Iter-152）：这条链终点是四语界面，句子在那儿会中英夹排。
    // 详细的中文说明留给日志——读日志的人是开发者，不受界面语言影响。
    log.warn(`拒探 ${delegateKey(providerId, model)}：这台模型已被设为「走文本协议」，而探针考察的是原生工具调用路径 ⇒ 结果不可信`)
    return { entry: unknownEntry(providerId, model), error: { code: 'text_protocol_forced' } }
  }

  const key = delegateKey(providerId, model)
  if (runningProbes.has(key)) {
    log.warn(`拒探 ${key}：这一台已经有一发在探，两发叠在同一台模型上只会互相拖慢`)
    return { entry: unknownEntry(providerId, model), error: { code: 'probe_running' } }
  }

  const adapter = providerManager.getAdapter(providerId)
  const total = Math.min(10, Math.max(1, Math.round(runs)))
  const samples: ProbeReply[] = []
  let transportErrors = 0
  let timeouts = 0
  let abortedByUser = false

  const outer = new AbortController()
  runningProbes.set(key, outer)
  try {
    for (let i = 0; i < total; i++) {
      // 每一发一把独立的中止器：超时或用户停止都只掐这一发，随后那几发由 break 决定要不要跑
      const ctl = new AbortController()
      const relay = (): void => ctl.abort()
      outer.signal.addEventListener('abort', relay, { once: true })
      let timedOut = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await adapter.streamChat(
          [
            { role: 'system', content: DELEGATE_PROBE.systemPrompt },
            { role: 'user', content: DELEGATE_PROBE.userPrompt }
          ],
          {
            model,
            temperature: 0,
            maxTokens: 220,
            tools: [PROBE_TOOL],
            toolChoice: 'auto',
            signal: ctl.signal,
            // §246：超时的钟**从排到槽之后**才起。本地那张卡被占住时排队是这套调度的设计（M5／M6），
            // 把排队那一段算成"这台模型不回话"就是把用户指向错的结论；`onSlotStart` 由闸门在真要发请求时回调。
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
          replyToProbeSample({
            content: result.content ?? '',
            toolCalls: (result.toolCalls ?? []).map((c) => ({
              name: c.function.name,
              arguments: c.function.arguments
            }))
          })
        )
      } catch (e) {
        if (outer.signal.aborted) {
          // 用户点的「停止」：这一发不算样本，整探就此收住（也不落库）
          abortedByUser = true
          log.warn(`探针被用户中止 ${key}：已跑完 ${samples.length}/${total} 发 ⇒ 不下结论`)
          break
        }
        if (timedOut) {
          timeouts++
          log.warn(
            `探针第 ${i + 1} 发在飞 ${probeSampleTimeoutMs}ms 仍没回音 ⇒ 中止这一发并停止后续（端点收了连接不回话，再问下去只是让用户多等）`
          )
          break
        }
        transportErrors++
        samples.push({ ok: false, nativeCall: false, fencedCall: false })
        log.warn(`委派探针第 ${i + 1} 次失败: ${errMsg(e)}`)
      } finally {
        if (timer) clearTimeout(timer)
        outer.signal.removeEventListener('abort', relay)
      }
    }
  } finally {
    runningProbes.delete(key)
  }

  const judged = judgeDelegateProbe(samples)
  const entry: DelegateCapabilityEntry = {
    key,
    providerId,
    model,
    capability: judged.capability,
    samples: judged.samples,
    nativeHits: judged.nativeHits,
    digest: '',
    checkedAt: Date.now()
  }
  // **任何一次请求失败都不落库**：unknown 是一个"没结论"的结论，
  // 拿它覆盖上一轮的 native_tools_ok 等于把已知信息丢掉（用户会看到"没探过"，其实只是这台今天连不上）。
  // §246 起超时与用户中止走同一句"没跑完"，但码不同——界面那句要指不同的路。
  const error: DelegateFailure | null = abortedByUser
    ? { code: 'probe_aborted' }
    : timeouts > 0
      ? {
          code: 'probe_timeout',
          // 只给数与单位换算，整句中文留给字典（152 那条口径：这条链的终点是四语界面）
          params: { failed: timeouts, total, sec: Math.round(probeSampleTimeoutMs / 1000) }
        }
      : transportErrors > 0
        ? { code: 'probe_incomplete', params: { failed: transportErrors, total } }
        : null
  if (transportErrors > 0 || timeouts > 0) {
    log.warn(
      `探测未跑完 ${key}：失败 ${transportErrors} 发、超时 ${timeouts} 发（共 ${total}）⇒ 保留此前的判定（有失败就不下结论，也不写 unknown 覆盖）`
    )
  }
  if (!error) {
    entry.digest = await digestOfModel(providerId, model)
    saveEntry(entry)
  }

  return { entry, error }
}

/** 给界面用：附上"这台模型的判定是否已过期"（只有拿得到 digest 的本地模型能判） */
export async function listDelegateCapabilitiesWithStaleness(): Promise<DelegateCapabilityView[]> {
  const entries = listDelegateCapabilities()
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
    stale: isDelegateEntryStale(e, localProviders, details),
    delegationEnabled: listDelegationEnabledModels().includes(delegateKey(e.providerId, e.model))
  }))
}

/**
 * 开/关某台模型的「允许顺序委派」（决策③：默认关，用户点名才开）。
 *
 * 这里是**唯一**写这份开关的地方，所以两条前置条件也只在这里判一次：
 *  ① 探针必须判出 `native_tools_ok`，且结论**未过期**（本地镜像换了 digest 就得重探——
 *     拿着旧结论开新权限，等于允许一台今天不一定派得出活的模型去开子 run）；
 *  ② 该模型没有被设为「走文本协议」——文本协议下原生工具调用路径根本不成立，
 *     而委派靠的就是那条路径（决策①：围栏那条路实测不可靠，已定论不放宽）。
 * 引擎侧只读 `delegate-prefs.isDelegationEnabledFor`，不再重复判能力（同一份口径只写一处）。
 */
export function setDelegationEnabled(
  providerId: string,
  model: string,
  on: boolean
): { ok: boolean; error: DelegateFailure | null; models: string[] } {
  const current = listDelegationEnabledModels()
  // 拒绝也只回码（V4-Iter-152）：这三句的终点是设置页那行提示，四语界面下中文句子会中英夹排。
  // 「为什么被拒」的具体数字/判定值放 params，由界面插进自己语言的句子；详细中文留日志。
  const refuse = (error: DelegateFailure) => {
    log.warn(`拒绝开启委派 ${delegateKey(providerId, model)}：${error.code}${error.params ? ' ' + JSON.stringify(error.params) : ''}`)
    return { ok: false as const, error, models: current }
  }

  if (on) {
    if (isTextProtocolForced(providerId, model)) {
      return refuse({ code: 'text_protocol_forced' })
    }
    const entry = listDelegateCapabilities().find((e) => e.key === delegateKey(providerId, model))
    if (!entry) {
      return refuse({ code: 'never_probed' })
    }
    if (entry.capability !== 'native_tools_ok') {
      return refuse({
        code: 'not_capable',
        params: { capability: entry.capability, hits: entry.nativeHits, samples: entry.samples }
      })
    }
  }

  return { ok: true, error: null, models: addOrRemoveDelegationEnabled(providerId, model, on) }
}

/** 当前被点名允许委派的模型键（只读；引擎的判定入口在 delegate-prefs） */
export function listDelegationEnabled(): string[] {
  return listDelegationEnabledModels()
}

export const __probeToolForTest = PROBE_TOOL
