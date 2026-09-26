// 渲染层通用格式化工具

/** 字节数 → 人类可读字符串（B/KB/MB/GB/TB），非有限值或 ≤0 返回 '-' */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
