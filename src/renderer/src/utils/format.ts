// 渲染层通用格式化工具

/**
 * 字节数 → 人类可读字符串（B/KB/MB/GB/TB）。
 * §378：`0` 与「拿不到」是两件事——0 是"确实没有"（说 `0 B`），只有非有限值或负数（读失败的产物）才说 '-'。
 * 以前两者共用 '-'，于是"回收了 0 字节""附件为空""这一项压根没读到"三张脸在屏上长成同一个串。
 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}
