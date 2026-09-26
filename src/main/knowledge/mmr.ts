// MMR（Maximal Marginal Relevance）结果多样性重排：
// 在「与查询相关」和「与已选结果不重复」之间权衡，避免注入多个高度相似的 chunk。
// mmr = λ * relevance(d) - (1 - λ) * max sim(d, selected)
import type { RetrievedChunk } from '../../shared/types'

/** 余弦相似度；零向量返回 0（避免 NaN） */
function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i]!
    const bv = b[i]!
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/** 把分数 min-max 归一化到 [0,1]；全部相等时返回全 1（保持相关性中性） */
function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return []
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min
  if (range === 0) return scores.map(() => 1)
  return scores.map((s) => (s - min) / range)
}

/**
 * MMR 选择：
 * @param candidates 已按相关性排好序的候选（rerank 或 RRF 之后）
 * @param vecs 候选 id → embedding（缺失的候选不参与多样性惩罚，维度不同视为不相似）
 * @param count 最终返回条数
 * @param lambda 相关性权重（0~1），越大越偏相关，越小越偏多样性，默认 0.5
 */
export function mmrSelect(
  candidates: RetrievedChunk[],
  vecs: Map<string, Float32Array>,
  count: number,
  lambda = 0.5
): RetrievedChunk[] {
  if (count <= 0) return []
  if (candidates.length <= count) return [...candidates]

  const relevance = normalizeScores(candidates.map((c) => c.score))
  const remaining = new Set(candidates.map((_, i) => i))
  const selectedIdx: number[] = []
  const maxSimToSelected = new Array<number>(candidates.length).fill(0)

  // 第一条：相关性最高
  let firstIdx = 0
  for (let i = 1; i < relevance.length; i++) {
    if (relevance[i]! > relevance[firstIdx]!) firstIdx = i
  }
  selectedIdx.push(firstIdx)
  remaining.delete(firstIdx)

  const vecOf = (i: number): Float32Array | undefined =>
    vecs.get(candidates[i]!.chunkId)

  while (selectedIdx.length < count && remaining.size > 0) {
    const lastAdded = selectedIdx[selectedIdx.length - 1]!
    const lastVec = vecOf(lastAdded)

    let bestIdx = -1
    let bestMmr = -Infinity

    for (const i of remaining) {
      // 增量更新与已选集合的最大相似度（只需和新加入的比较）
      if (lastVec) {
        const v = vecOf(i)
        if (v && v.length === lastVec.length) {
          const sim = cosine(v, lastVec)
          if (sim > maxSimToSelected[i]!) maxSimToSelected[i] = sim
        }
      }
      const mmr = lambda * relevance[i]! - (1 - lambda) * maxSimToSelected[i]!
      if (mmr > bestMmr) {
        bestMmr = mmr
        bestIdx = i
      }
    }

    if (bestIdx === -1) break
    selectedIdx.push(bestIdx)
    remaining.delete(bestIdx)
  }

  return selectedIdx.map((i) => candidates[i]!)
}
