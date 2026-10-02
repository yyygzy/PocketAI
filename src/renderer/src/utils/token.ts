// token / 费用展示格式化（用量面板与聊天气泡共用，口径统一）

/** token 数量级缩写：<1000 原样，≥1000 显示 k，≥1M 显示 M */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(n)
}

/** 费用格式：≥1 两位小数，0<n<1 四位小数，0/非法 → 空串（UI 显示 — 或隐藏） */
export function fmtCost(n: number): string {
  if (!n || n <= 0) return ''
  if (n >= 1) return n.toFixed(2)
  return n.toFixed(4)
}
