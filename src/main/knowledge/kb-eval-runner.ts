// 评测集运行器：把一份「问题 → 期望命中」的卷子接到真检索上，逐条 retrieve，算出 recall@k / MRR / 漏召回清单。
//
// 判分本身在 `shared/kb-eval.ts`（纯函数，V4-Iter-128 就备好了），这里只干三件运行期才有的事：
//  1. 读文件并**严格**解析（坏卷子当场拒绝，不"宽容补默认值"）；
//  2. 按卷子绑定的那个库跑真检索（走的是生产同一条 `ragService.retrieve`，包括每库自己的阈值）；
//  3. 把「这份卷子本身坏在哪」一起报出来——期望目标失效（文档被删/被去重合并）时指标照样算得出来，
//     但那是在一张坏卷子上打分；期望引用的文档被停用了也一样一定漏。这两件事必须和分数同屏。
//
// k 的含义是「注入前 k 条够不够」，缺省取该库自己的 topN——问的正是平时那套注入配置下的表现。
import fs from 'node:fs'
import path from 'node:path'
import { kbRepo } from '../db/repositories/kb.repo'
import { kbDocRepo } from '../db/repositories/kb-doc.repo'
import { ragService } from './rag'
import { recordPerf, logPerfDebug } from '../steward/perf-probe'
import {
  findStaleTargets,
  parseKbEvalSet,
  summarizeEval,
  toEvalMetrics,
  type KbEvalRunResult,
  type KbEvalSet,
  type RankedHit
} from '../../shared/kb-eval'

/** 卷子的读入上限：它是人写的东西，超过这个体量先怀疑选错了文件，而不是慢慢啃 */
const MAX_EVAL_BYTES = 2 * 1024 * 1024
/** 「注入前 k 条」的硬上限，与 IPC 入参 schema 同值（两处不同步就会出现"schema 收下、运行器改掉"） */
export const KB_EVAL_MAX_K = 50
/** 整份卷子的耗时进慢操作缓冲的阈值：跑 N 题天然慢，这个数只为事后能查它跑了多久 */
const SLOW_EVAL_MS = 3000
/** 逐条列出「实际返回了什么」的条数上限：让用户能照着真 docId/seq 去改下一版卷子，同时控制 IPC 载荷 */
const MAX_RETURNED_PER_ROW = 12
const MAX_TITLE_CHARS = 80

export interface RunKbEvalInput {
  kbId: string
  /**
   * 由 `KB_EVAL_PICK` 通过 SEC-6 的对话框路径令牌换回来的绝对路径。
   * 渲染层拿不到也传不进任意路径：它只持有令牌字符串。
   */
  filePath: string
  fileName?: string
  /** 评测深度；不传 = 用该库自己的 topN */
  k?: number
}

export function kbEvalFileName(filePath: string): string {
  return path.basename(filePath)
}

/** 读文件 → 解析 → 与选中的库对齐。任何一步不过关都抛中文错误，交给 safeHandle 转成结构化失败 */
export function loadKbEvalSet(filePath: string, kbId: string): KbEvalSet {
  let size: number
  try {
    const st = fs.statSync(filePath)
    if (!st.isFile()) throw new Error('评测集路径不是一个文件')
    size = st.size
  } catch (e) {
    if (e instanceof Error && e.message === '评测集路径不是一个文件') throw e
    throw new Error(`读不到评测集文件：${filePath}`)
  }
  if (size > MAX_EVAL_BYTES) {
    throw new Error(`评测集文件 ${Math.round(size / 1024)} KB，超过 2 MB 上限——确认没有选错文件`)
  }
  const set = parseKbEvalSet(fs.readFileSync(filePath, 'utf8'))
  if (set.kbId !== kbId) {
    throw new Error(`这份卷子是为库「${set.kbId}」出的，当前选的是「${kbId}」——一份评测集只绑一个库`)
  }
  return set
}

/**
 * 跑一份卷子。逐条**串行**检索：并发会把同一个库的 embedding 远程 API 一次打满，
 * 而这份卷子存在的意义之一就是看清真实延迟。
 */
export async function runKbEvalSet(input: RunKbEvalInput): Promise<KbEvalRunResult> {
  const kb = kbRepo.get(input.kbId)
  if (!kb) throw new Error('知识库不存在')
  const set = loadKbEvalSet(input.filePath, kb.id)
  const k = Math.max(1, Math.min(input.k ?? kb.topN ?? 5, KB_EVAL_MAX_K))

  const docs = kbDocRepo.list(kb.id)
  const byId = new Map(docs.map((d) => [d.id, d]))
  const stale = findStaleTargets(set, byId.keys())
  const disabledTargets: KbEvalRunResult['disabledTargets'] = []
  for (const c of set.cases) {
    for (const t of c.expected) {
      const d = byId.get(t.docId)
      if (d && !d.enabled) disabledTargets.push({ caseId: c.id, docId: t.docId, title: d.title || d.source })
    }
  }

  const warnings: string[] = []
  if (!kb.embeddingProviderId || !kb.embeddingModel) {
    warnings.push('该库没有配置 Embedding 模型：向量路不参与，这份分数只反映全文检索与融合结果')
  }
  if (stale.length > 0) warnings.push(`有 ${stale.length} 个期望目标引用的文档已不存在，指标是在坏卷子上算的`)

  const queryOf = new Map(set.cases.map((c) => [c.id, c.query]))
  const hitsOf: Record<string, RankedHit[]> = {}
  const returnedOf: Record<string, KbEvalRunResult['rows'][number]['returned']> = {}
  const t0 = performance.now()
  for (const c of set.cases) {
    const r = await ragService.retrieve([kb.id], c.query, { topN: k })
    hitsOf[c.id] = r.chunks.map((x) => ({ docId: x.docId, seq: x.seq }))
    returnedOf[c.id] = r.chunks.slice(0, MAX_RETURNED_PER_ROW).map((x) => ({
      docId: x.docId,
      seq: x.seq,
      title: (x.docTitle || '').slice(0, MAX_TITLE_CHARS)
    }))
  }
  const summary = summarizeEval(set, hitsOf, k)
  const elapsedMs = Math.round(performance.now() - t0)
  const detail =
    `cases=${set.cases.length} k=${k} recall=${summary.recallAtK.toFixed(3)} ` +
    `mrr=${summary.mrr.toFixed(3)} missed=${summary.missedCases} stale=${stale.length}`
  if (elapsedMs >= SLOW_EVAL_MS) recordPerf('kb.eval', elapsedMs, detail)
  else logPerfDebug('kb.eval', elapsedMs, detail)

  return {
    name: set.name,
    kbId: kb.id,
    fileName: input.fileName ?? kbEvalFileName(input.filePath),
    metrics: toEvalMetrics(summary),
    rows: summary.perCase.map((p) => ({
      caseId: p.caseId,
      query: queryOf.get(p.caseId) ?? '',
      expected: p.expected,
      matched: p.matched,
      firstRank: p.firstRank,
      recallAtK: p.recallAtK,
      missing: p.missing,
      returned: returnedOf[p.caseId] ?? []
    })),
    stale,
    disabledTargets,
    warnings,
    elapsedMs
  }
}
