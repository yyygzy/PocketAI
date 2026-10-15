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
 * 探一台模型一次（默认 3 发）。串行是刻意的：并发会把同一台本地模型一次打满，
 * 而探针本身跑在用户的显存上（V4-Iter-141 的槽位会排队，这里不再叠一层并发）。
 */
export async function probeDelegateCapability(
  providerId: string,
  model: string,
  runs: number = MIN_PROBE_RUNS
): Promise<ProbeOutcome> {
  if (isTextProtocolForced(providerId, model)) {
    const why = '这台模型已被设为「走文本协议」，探针考察的是原生工具调用路径，结果不会可信 ⇒ 请先关掉该开关再探测'
    return {
      entry: {
        key: delegateKey(providerId, model),
        providerId,
        model,
        capability: 'unknown',
        samples: 0,
        nativeHits: 0,
        digest: '',
        checkedAt: Date.now()
      },
      error: why
    }
  }

  const adapter = providerManager.getAdapter(providerId)
  const total = Math.min(10, Math.max(1, Math.round(runs)))
  const samples: ProbeReply[] = []
  let transportErrors = 0

  for (let i = 0; i < total; i++) {
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
          toolChoice: 'auto'
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
      transportErrors++
      samples.push({ ok: false, nativeCall: false, fencedCall: false })
      log.warn(`委派探针第 ${i + 1} 次失败: ${errMsg(e)}`)
    }
  }

  const judged = judgeDelegateProbe(samples)
  const entry: DelegateCapabilityEntry = {
    key: delegateKey(providerId, model),
    providerId,
    model,
    capability: judged.capability,
    samples: judged.samples,
    nativeHits: judged.nativeHits,
    digest: await digestOfModel(providerId, model),
    checkedAt: Date.now()
  }
  // **任何一次请求失败都不落库**：unknown 是一个"没结论"的结论，
  // 拿它覆盖上一轮的 native_tools_ok 等于把已知信息丢掉（用户会看到"没探过"，其实只是这台今天连不上）。
  const error =
    transportErrors > 0
      ? `探测未跑完：${transportErrors}/${total} 次请求失败，保留此前的判定（有失败就不下结论，也不写 unknown 覆盖）`
      : null
  if (transportErrors === 0) saveEntry(entry)

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
  return entries.map((e) => ({ ...e, stale: isDelegateEntryStale(e, localProviders, details) }))
}

export const __probeToolForTest = PROBE_TOOL
