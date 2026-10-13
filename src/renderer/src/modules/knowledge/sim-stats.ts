// 相似度统计（V4-Iter-127）：把「本次注入片段的余弦相似度分布」压成三个数给用户看
//
// 为什么要单独一个纯函数而不是在组件里就地算：KnowledgeModule 太大、没有挂载先例，
// 面板里的显示只有肉眼能验；把口径（取哪些数、中位数怎么算、空值怎么处理）收进
// 一个能单测的函数，至少能保证「数字本身」不是随手糊的。
export interface SimStats {
  /** 有相似度的片段条数（不等于注入总条数：没向量/维度不符的算不出来） */
  count: number
  min: number
  median: number
  max: number
}

/** 保留两位小数（面板显示用；不做四舍五入以外的加工） */
export function fmtSim(v: number): string {
  return v.toFixed(2)
}

/**
 * 汇总相似度分布。全是 undefined（主链路没算、或整条向量路没跑成）就返回 null，
 * 调用方据此不渲染——不要拿 0 顶替「不知道」。
 */
export function similarityStats(values: Array<number | undefined>): SimStats | null {
  const nums = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (nums.length === 0) return null
  const sorted = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  return { count: nums.length, min: sorted[0]!, median, max: sorted[sorted.length - 1]! }
}
