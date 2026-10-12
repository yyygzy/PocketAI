// 默认服务商的选取规则（对话页 / 浮窗等"自动挑一个 provider"的地方共用）
//
// 为什么要有这条：`enabled` 不等于"能用"。服务商的模型列表是缓存（拉取模型或手动填才有），
// 停用一个没拉过模型的 provider、或在设置里把已缓存模型逐个删完后保存，都会留下
// "enabled 但 models 为空"的记录。旧代码 `list.filter(p => p.enabled)[0]` 会直接选中它，
// 于是 `targets` 里的 model 是空串 → 发送被禁 → 提示却写"请先在设置中配置模型服务商"，
// 而用户明明配了服务商。规则改成：**优先挑有模型的**，全都没有模型时仍返回其中一个，
// 好让界面能指出真问题（去拉取模型），而不是假装没有服务商。
import type { ChatTarget, ProviderRecord } from '../../../shared/types'

/** 该服务商当前有没有可选项（模型列表非空） */
export function hasUsableModel(p: ProviderRecord | undefined | null): boolean {
  return !!p && p.enabled && (p.models?.length ?? 0) > 0
}

/**
 * 挑默认服务商：
 * ① 记住的那家（preferredId）仍在且**有模型** → 用它；
 * ② 否则第一家「启用且有模型」的；
 * ③ 一家有模型的都没有 → 退回第一家启用的（哪怕模型为空），让 UI 能给出"去拉取模型"的指引；
 * ④ 完全没有启用的 → null。
 */
export function pickDefaultProvider(
  providers: ProviderRecord[],
  preferredId?: string | null
): ProviderRecord | null {
  const enabled = providers.filter((p) => p.enabled)
  if (enabled.length === 0) return null
  if (preferredId) {
    const remembered = enabled.find((p) => p.id === preferredId)
    if (remembered && hasUsableModel(remembered)) return remembered
  }
  return enabled.find((p) => hasUsableModel(p)) ?? enabled[0]!
}

/**
 * 当前选择在新一轮服务商列表里是否仍然有效——有效就别动它（用户可能手选过模型）。
 *
 * 注意 `model` 为空串一定算**无效**：那正是"上次挑到的服务商还没有模型列表"的状态，
 * 用户去设置里拉完模型切回来，就必须重挑才能立刻能发。
 */
export function isTargetStillValid(cur: ChatTarget | undefined, providers: ProviderRecord[]): boolean {
  if (!cur || !cur.providerId || !cur.model) return false
  const p = providers.find((x) => x.id === cur.providerId)
  return !!p && p.enabled && (p.models ?? []).includes(cur.model)
}
