type TranslateFn = (key: string, params?: Record<string, string | number>) => string

/**
 * approval `reason_code` → 自然语言（审批弹窗与审批明细屏共用）。
 * - 有 `agent.approval.reason.<code>` 就翻译；
 * - 没有（例如策略里带后缀的 `DENY_RULE:...`）回退显示原始 code——宁可露出原文，也不吞掉。
 *
 * 这里刻意保留全仓唯一一处"按 code 拼 key"的动态调用点：两个消费方走同一个入口，
 * 动态调用点总数不变（i18n-interpolation-361 的 105 不因此增加）。
 */
export function approvalReasonText(reason: string | null | undefined, t: TranslateFn): string {
  if (!reason) return ''
  const key = `agent.approval.reason.${reason}`
  const text = t(key)
  return text === key ? reason : text
}
