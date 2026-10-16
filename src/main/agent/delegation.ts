// 建子会话 + 组装子 run 的 payload（V4-Iter-144），以及"这个角色用哪台模型"的落点解析（V4-Iter-145）
//
// 纯规则（角色枚举、预算、工具面裁剪、参数校验、schema 交换）都在 `shared/delegation-rules.ts`，
// 这里只留**必须碰库**的那两步：建子会话、对着 provider 表解析模型名。分家的理由写在那份文件的开头
// （工具注册表也被迫拉起 electron 链）。
//
// 本模块**不许 import agentEngine**：engine 要 import 这里，会成环；真正跑子 run 的是 engine。
import { randomUUID } from 'node:crypto'
import { conversationRepo } from '../db/repositories/conversation.repo'
import { providerRepo } from '../db/repositories/provider.repo'
import { isLocalInferenceBaseUrl } from '../providers/local-slot'
import type { ChatTarget, SendMessagePayload } from '../../shared/types'
import { ROLE_BRIEF, type DelegateRole } from '../../shared/delegation-rules'

export interface ChildRunPlan {
  childConversationId: string
  payload: SendMessagePayload
}

/**
 * 建子会话 + 组装子 run 的 payload。
 * `target` 由 `resolveChildTarget` 决定：144 只给同模型（沿用父的 provider+model），
 * 145 起可以是另一台模型——**但那条路由容量判据（`mayAssignDistinctModelRole`）先把关**，
 * 判据没过时 `resolveChildTarget` 根本不会被调用到跨模型那一支（见 engine 的 DELEGATE_DISTINCT_BLOCKED）。
 */
export function planChildRun(input: {
  parentConversationId: string
  assistantId: string | null
  role: DelegateRole
  task: string
  target: ChatTarget
}): ChildRunPlan {
  const child = conversationRepo.create({
    assistantId: input.assistantId,
    title: `子代理 · ${input.role}`,
    modelLabel: `agent:${input.target.providerId}:${input.target.model}`,
    parentConversationId: input.parentConversationId,
    roleKey: input.role
  })
  const payload: SendMessagePayload = {
    requestId: randomUUID(),
    conversationId: child.id,
    assistantId: input.assistantId,
    content: `${ROLE_BRIEF[input.role]}\n\n任务：${input.task}`,
    targets: [input.target],
    agentMode: true,
    // 无人值守是第二道保险：confirm 类已经在 childToolSurface 里被摘掉了，万一模型凭空调一个，
    // 让它明确失败，而不是挂起等一个永远不会来的弹窗。
    unattended: true
  }
  return { childConversationId: child.id, payload }
}

// ---------- 145：角色落点（哪个角色用哪台模型） ----------

/** `providerId::model` 的显式写法分隔符（与文本协议键、delegateKey 同形，便于用户对照） */
const KEY_SEP = '::'

/**
 * "这条端点是不是吃本机显存"。**直接复用 141 闸门里那一个谓辞**（`isLocalInferenceBaseUrl`），
 * 不在这里另写一份"什么算本地"：两处判据迟早会漂，而判错的方向是"把本地当云 ⇒ 并发发出 ⇒
 * 到闸门里排队"，正是 141 注释里那条"别把没数据实现成变慢"。
 * 认不出端点（provider 记录缺 baseUrl）按本地处理 ⇒ 保守走串行。
 */
function endpointIsLocal(baseUrl: string | undefined): boolean {
  if (!baseUrl) return true
  return isLocalInferenceBaseUrl(baseUrl)
}

interface ModelAddress {
  providerId: string
  model: string
  endpointLocal: boolean
}

/** 启用中的 provider × 其**已缓存**的模型名（去重后） */
function enabledModelAddresses(): ModelAddress[] {
  const out: ModelAddress[] = []
  for (const p of providerRepo.list()) {
    if (!p?.enabled) continue
    for (const m of p.models ?? []) {
      if (typeof m !== 'string') continue
      const model = m.trim()
      if (!model) continue
      if (out.some((a) => a.providerId === p.id && a.model === model)) continue
      out.push({ providerId: p.id, model, endpointLocal: endpointIsLocal(p.baseUrl) })
    }
  }
  return out
}

/**
 * 给 schema 的候选清单：**精确匹配，不做家族匹配**（同 142 那条 digest 教训——`qwen2.5:3b` 与
 * `qwen2.5:3b-instruct` 是两台模型，让它们互相顶替会把"没测过的端点"当成"测过的"）。
 * 同名模型挂在多家下时，裸名会歧义 ⇒ 这一条改用 `providerId::model` 全名，保证清单里每一项都能直接填。
 *
 * `allow` 是 150 加的第二道形：清单**只列当时放得开的落点**（用户选定 A2）。理由不是省事——
 * 144/145 定的形状是"放不开就让模型看不见这个参数"，而新口径下"放不放得开"依候选落在本地还是云上而不同，
 * 于是这句话只能逐候选回答。把全部候选都列出来再逐次拒，就退回了 118 那轮"看得见但被拒"的形状。
 * 逐次放行的那道闸门（`prepareDelegation`）照旧保留，它是纵深，不是清单的替代品。
 */
export function listRoleModelOptions(
  parentProviderId: string,
  allow: (candidate: { providerId: string; model: string; endpointLocal: boolean }) => boolean
): string[] {
  const addresses = enabledModelAddresses().filter(allow)
  const bareCount = new Map<string, number>()
  for (const a of addresses) bareCount.set(a.model, (bareCount.get(a.model) ?? 0) + 1)
  const labels = addresses.map((a) => ({
    providerId: a.providerId,
    label: (bareCount.get(a.model) ?? 0) > 1 ? `${a.providerId}${KEY_SEP}${a.model}` : a.model
  }))
  labels.sort((x, y) => {
    const xp = x.providerId === parentProviderId ? 0 : 1
    const yp = y.providerId === parentProviderId ? 0 : 1
    return xp - yp || x.label.localeCompare(y.label)
  })
  return [...new Set(labels.map((l) => l.label))]
}

export type ChildTargetResolution =
  | { ok: true; target: ChatTarget; distinct: boolean; endpointLocal: boolean }
  | { ok: false; error: string }

/**
 * 把控制器给出的 `model` 解析成一次子 run 的落点。
 *
 * 谁决定用哪台模型（用户 2026-10-16 选定）：**控制器在 `delegate_task` 里带 model 参数**，
 * 所以这里面对的输入是模型写的，不是用户点的 ⇒ 三条拒绝都要给得出可执行的下一步：
 *  ① 未缓存的模型名 → 指「设置 → 模型服务商 → 拉取模型」（不猜：写个不存在的模型名去请求，
 *     失败要等到端点报错才看得见，而那时已经花了一次推理）；
 *  ② 裸名挂在多家下 → 要求写 `providerId::model`（选错一家比派错人更难发现）；
 *  ③ provider 被停用 → 直接说停用。
 * `model` 省略 = 沿用父的落点，`distinct=false`（跨模型判据因此只在真的换模型时才适用）。
 */
export function resolveChildTarget(parent: ChatTarget, requested: string | null): ChildTargetResolution {
  const addresses = enabledModelAddresses()
  if (!requested) {
    const self = addresses.find((a) => a.providerId === parent.providerId && a.model === parent.model)
    // 父的落点没在缓存表里也照常放行：它此刻正在被使用，缓存列表只是"我们知道的模型"的账本，
    // 不是准入名单。判不出本地/云时按本地走（保守 = 串行）。
    return { ok: true, target: parent, distinct: false, endpointLocal: self?.endpointLocal ?? true }
  }

  const want = requested.trim()
  const sep = want.indexOf(KEY_SEP)
  if (sep > 0) {
    const providerId = want.slice(0, sep).trim()
    const model = want.slice(sep + KEY_SEP.length).trim()
    const hit = addresses.find((a) => a.providerId === providerId && a.model === model)
    if (hit) {
      return {
        ok: true,
        target: { providerId: hit.providerId, model: hit.model },
        distinct: hit.providerId !== parent.providerId || hit.model !== parent.model,
        endpointLocal: hit.endpointLocal
      }
    }
    const provider = providerRepo.get(providerId)
    if (!provider) return { ok: false, error: `model "${want}"：没有这个 provider（${providerId}）` }
    if (!provider.enabled) return { ok: false, error: `model "${want}"：provider「${provider.name}」已停用` }
    return {
      ok: false,
      error: `model "${want}"：不在 provider「${provider.name}」的模型列表里。请先在「设置 → 模型服务商」点「拉取模型」，再从清单里原样选一个名字。`
    }
  }

  const matches = addresses.filter((a) => a.model === want)
  if (matches.length === 1) {
    const hit = matches[0]!
    return {
      ok: true,
      target: { providerId: hit.providerId, model: hit.model },
      distinct: hit.providerId !== parent.providerId || hit.model !== parent.model,
      endpointLocal: hit.endpointLocal
    }
  }
  if (matches.length > 1) {
    return {
      ok: false,
      error: `model "${want}" 同时挂在 ${matches.length} 家 provider 下，无法确定用哪家。请写成 providerId::${want}`
    }
  }
  return {
    ok: false,
    error: `model "${want}"：不在任何已启用 provider 的模型列表里。可省略 model 沿用当前模型，或先在「设置 → 模型服务商」点「拉取模型」。`
  }
}
