// 本机判据的一次汇总（V4-Iter-146）
//
// 这块代码只做一件事：**把已经存在的判据原样搬出来**，不新写任何判断——
//  · 容量档来自 `capacitySnapshot()`（与 141 闸门同一次读取，界面上说的总量就是闸门据以判定的总量）；
//  · 「跨模型角色」的第二条合取按助手算，用的是引擎那**同一个** `surfaceUsesRetrieval`；
//  · 委派判定复用 142 的 `listDelegateCapabilitiesWithStaleness`，不在这里再判一次能力。
// 任何"这里再算一遍"都会造出第二份口径，那正是本仓一路在避免的漂移源（118 / 144 两轮的同族教训）。
//
// 实时显存走 `readGpuMemoryLive()`（异步那条）：**不许**在这一屏用同步的 `getHardwareInfo()` 刷新，
// 那会把主进程事件循环钉住最多 3s，卡的是正在流式输出的对话与所有 IPC。
import { assistantRepo } from '../db/repositories/assistant.repo'
import { toolRegistry } from '../tools/registry'
import { capacitySnapshot, localSlotSnapshot } from '../providers/local-slot'
import { mayAssignDistinctModelRole } from '../agent/local-capacity'
import { resolveAgentToolPermissions } from '../agent/engine'
import { listDelegateCapabilitiesWithStaleness } from '../agent/delegate-capability'
import { surfaceUsesRetrieval } from '../../shared/delegation-rules'
import { readGpuMemoryLive } from './hardware'
import type { LocalJudgementReport } from '../../shared/local-judgement'

export interface LocalJudgementDeps {
  /** 注入点：用例里替掉它就不依赖真 nvidia-smi（生产不传，走 `readGpuMemoryLive`） */
  readLiveVram?: () => Promise<Array<{ name: string; totalMiB: number | null; usedMiB: number | null }>>
  /** 注入点：报告时刻（用例要确定性时给） */
  now?: () => number
}

/**
 * 汇总一份判据报告。**只读**：不写库、不改开关、不发起任何模型请求。
 * 采不到的东西一律如实标"采不到"，绝不填估算值（140 立的那条纪律在这块屏上的唯一落点）。
 */
export async function computeLocalJudgements(deps: LocalJudgementDeps = {}): Promise<LocalJudgementReport> {
  const { totalVramMiB, decision } = capacitySnapshot()
  const readLive = deps.readLiveVram ?? readGpuMemoryLive
  const now = deps.now ?? (() => Date.now())

  // 第二条合取按助手算：与引擎筛工具面时同一个谓辞（kbIds 或工具面里有 kb_search）
  const roleVerdicts = assistantRepo.list().map((a) => {
    const permissions = resolveAgentToolPermissions(a.toolPermissions, {
      hasAssistant: true,
      isBuiltin: a.isBuiltin ?? false
    })
    const surface = toolRegistry.filterByPermissions(permissions)
    const childUsesRetrieval = surfaceUsesRetrieval(surface, a.knowledgeBaseIds ?? [])
    return {
      assistantName: a.name,
      childUsesRetrieval,
      verdict: mayAssignDistinctModelRole(decision, { childUsesRetrieval })
    }
  })

  const caps = await listDelegateCapabilitiesWithStaleness()
  const liveRows = await readLive().catch(() => [])

  return {
    collectedAt: now(),
    totalVramMiB,
    capacity: decision,
    liveVram: { available: liveRows.length > 0, rows: liveRows },
    slots: localSlotSnapshot(),
    roleVerdicts,
    delegations: caps.map((c) => ({
      key: c.key,
      model: c.model,
      capability: c.capability,
      samples: c.samples,
      nativeHits: c.nativeHits,
      stale: c.stale,
      delegationEnabled: c.delegationEnabled
    }))
  }
}
