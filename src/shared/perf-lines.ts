// 日志 [perf] 行的解析与跨会话聚合（纯函数：主进程读文件，本模块只认字符串）
//
// 为什么走日志而不是新建存储：慢事件本来就无条件 info 落盘（logger 写 main.log，
// 1MB 滚动到 main.old.log），再开一张表等于把同一份数据存两遍。面板要跨会话看，
// 就从已有的东西里读——并且**只把聚合结果过 IPC**，日志原文不下发渲染层
// （日志里可能有用户数据，见 SEC-14 的脱敏口径）。
import type { PerfEvent, PerfSummary } from './types'

/** 日志行时间戳前缀：`2026-10-10 08:12:34 INFO  [perf] [perf] kb.ingest: 123ms | detail` */
const TS_RE = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/
/** 事件体：label 允许字母数字与 . _ - :（渲染端长任务用 `renderer:longtask`）；ms 非负整数；detail 可选 */
const PERF_RE = /\[perf\]\s+([\w.:-]+):\s+(\d+)ms(?:\s*\|\s*([\s\S]*))?$/
const MODEL_RE = /(?:^|\s)model=(\S+)/
/** DEBUG 级 [perf] 行：未超阈值的快操作（logPerfDebug），不参与慢事件统计 */
const DEBUG_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}\s+DEBUG\b/

/** 最多归因几个模型（面板一行放不下，且明细已可在日志里查） */
const MAX_MODELS = 3

/**
 * 解析一行日志：不是 [perf] 慢事件就返回 null（调用方据此过滤，绝不把其它行外传）。
 * 另排除 DEBUG 级同格式行——那是未超阈值的快操作（logPerfDebug），混进来会把统计拉低。
 * 时间戳解析失败（例如被截断的行）按 0 处理，只影响「最近一次」列，不影响计数。
 */
export function parsePerfLine(line: string): PerfEvent | null {
  if (DEBUG_RE.test(line)) return null
  const m = PERF_RE.exec(line)
  if (!m) return null
  const ms = Number(m[2])
  if (!Number.isFinite(ms) || ms < 0) return null
  const t = TS_RE.exec(line)
  const at = t ? Date.parse(t[1]!.replace(' ', 'T')) : Number.NaN
  const detail = (m[3] ?? '').trim()
  return {
    label: m[1]!,
    ms,
    detail: detail === '' ? undefined : detail,
    at: Number.isFinite(at) ? at : 0
  }
}

/** 一批事件按 label 聚合（并把带 model= 的事件按模型再分一层）；count 降序、同数按 maxMs 降序，取前 topLabels 项 */
export function summarizePerf(events: readonly PerfEvent[], topLabels = 6): PerfSummary[] {
  interface Bucket {
    ms: number[]
    lastAt: number
    byModel: Map<string, number[]>
  }
  const byLabel = new Map<string, Bucket>()
  for (const e of events) {
    const bucket = byLabel.get(e.label) ?? { ms: [], lastAt: 0, byModel: new Map<string, number[]>() }
    bucket.ms.push(e.ms)
    if (e.at > bucket.lastAt) bucket.lastAt = e.at
    const model = e.detail ? MODEL_RE.exec(e.detail)?.[1] : undefined
    if (model) bucket.byModel.set(model, [...(bucket.byModel.get(model) ?? []), e.ms])
    byLabel.set(e.label, bucket)
  }
  const rows: PerfSummary[] = []
  for (const [label, b] of byLabel) {
    const sorted = [...b.ms].sort(ascending)
    rows.push({
      label,
      count: sorted.length,
      // 偶数样本取下中位数：不做插值，宁可少报半档也不虚高
      p50Ms: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0,
      lastAt: b.lastAt,
      byModel: modelStats(b.byModel)
    })
  }
  rows.sort((x, y) => y.count - x.count || y.maxMs - x.maxMs)
  return rows.slice(0, Math.max(0, topLabels))
}

function ascending(x: number, y: number): number {
  return x - y
}

/**
 * 同一标签内按模型再聚合，取样本数最多（同数取峰值最大）的前 MAX_MODELS 个：
 * 「对话首字耗时 6 次」这种混合数字没法归因，拆到模型才有用——哪个模型慢就盯哪个。
 */
function modelStats(byModel: Map<string, number[]>): PerfSummary['byModel'] {
  const stats: PerfSummary['byModel'] = []
  for (const [model, ms] of byModel) {
    const sorted = [...ms].sort(ascending)
    stats.push({
      model,
      count: sorted.length,
      p50Ms: sorted[Math.floor((sorted.length - 1) / 2)] ?? 0,
      maxMs: sorted[sorted.length - 1] ?? 0
    })
  }
  stats.sort((x, y) => y.count - x.count || y.maxMs - x.maxMs)
  return stats.slice(0, MAX_MODELS)
}
