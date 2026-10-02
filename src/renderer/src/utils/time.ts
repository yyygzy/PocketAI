// 时间格式化工具
//
// formatDateTime：Unix 毫秒 → 'YYYY-MM-DD HH:mm'（24 小时制，补零），
// 用于消息气泡 hover tooltip 与导出文件名；纯函数便于单测。
// daySeparatorLabel：日期分隔线文案——今天/昨天/更早返回 M月D日，需 i18n。

const pad = (n: number) => n.toString().padStart(2, '0')

export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 生成安全的文件名时间戳（无空格无冒号）：YYYYMMDD-HHmm */
export function fileTimestamp(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`
}

/**
 * 日期分隔线 label：今天/昨天/更早。
 * t 接收 chat.dateSepToday / chat.dateSepYesterday / chat.dateSepDate({m,d})。
 * 纯函数：输入 ts 与 now（便于测试冻结时间）。
 */
export function daySeparatorLabel(
  ts: number,
  t: (k: string, p?: Record<string, string | number>) => string,
  now: number = Date.now()
): string {
  const d = new Date(ts)
  const today = new Date(now)
  if (d.toDateString() === today.toDateString()) return t('chat.dateSepToday')
  const yesterday = new Date(now - 86_400_000)
  if (d.toDateString() === yesterday.toDateString()) return t('chat.dateSepYesterday')
  return t('chat.dateSepDate', { m: d.getMonth() + 1, d: d.getDate() })
}

/** 两条消息是否跨自然日（用于日期分隔线判定） */
export function isDifferentDay(a: number, b: number): boolean {
  return new Date(a).toDateString() !== new Date(b).toDateString()
}
