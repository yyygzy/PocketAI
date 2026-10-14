// 知识库评测集的数据结构与指标（V4-Iter-128，B 档第一步：只做数据结构，不做运行入口）
//
// 为什么先做数据结构：阈值/降级/相似度分布现在都能看见了，剩下的问题是
// 「这套检索到底有没有把该找的东西找回来」——那需要一份「问题 → 期望命中」的对照集。
// 两个承重事实决定了这里的形状：
//  1) **chunkId 不能当标识**。重新索引走 `kb-health.ts reindexDocs` → 同一 docId 重入队，
//     而 `ingestion.ts` 先 `deleteByDoc` 再插入、分块主键是 `randomUUID()` ⇒ 每次重建全变。
//     能用的只有 docId（文档级）与 docId+seq（分块级，seq 由分块参数决定，同参数下稳定）。
//  2) **期望目标会失效**。文档被删、被去重合并、改标题重加都会换掉 docId。
//     失效了必须查得出来（findStaleTargets），否则指标会继续算，却是在一份坏掉的卷子上算分。
//
// 指标是纯函数：输入是「每次检索的有序命中」，不依赖 rag / DB / embedding，
// 所以既能被运行器喂真结果，也能被单测喂假结果——而"该不该召回"这件事只由这里的期望决定。
import { z } from 'zod'

/** 评测集文件格式版本（结构变了要升它，旧文件读不进去要明确报错） */
export const KB_EVAL_FILE_VERSION = 1

const MAX_CASES = 200
const MAX_QUERY_CHARS = 4000
const MAX_ID_CHARS = 64
const MAX_NAME_CHARS = 200
const MAX_NOTE_CHARS = 500
const MAX_EXPECTED_PER_CASE = 10

const targetSchema = z
  .object({
    docId: z.string().min(1).max(MAX_ID_CHARS),
    /** 省略 = 文档级（该文档任一分块进入即算命中）；填了 = 精确到文档内第几块（0 起） */
    seq: z.number().int().nonnegative().optional()
  })
  .strict()

const caseSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_CHARS),
    query: z.string().min(1).max(MAX_QUERY_CHARS),
    /** 期望命中。至少一条，否则这条用例永远算满分——那是最坏的假绿 */
    expected: z.array(targetSchema).min(1).max(MAX_EXPECTED_PER_CASE),
    note: z.string().max(MAX_NOTE_CHARS).optional()
  })
  .strict()

export const kbEvalSetSchema = z
  .object({
    version: z.literal(KB_EVAL_FILE_VERSION),
    /** 一份卷子绑一个库：跨库的期望会因融合顺序变得说不清 */
    kbId: z.string().min(1).max(MAX_ID_CHARS),
    name: z.string().min(1).max(MAX_NAME_CHARS),
    cases: z.array(caseSchema).min(1).max(MAX_CASES)
  })
  .strict()
  .superRefine((set, ctx) => {
    const seen = new Set<string>()
    for (const [i, c] of set.cases.entries()) {
      if (seen.has(c.id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['cases', i, 'id'], message: `用例 id 重复：${c.id}` })
      }
      seen.add(c.id)
      for (const [j, t] of c.expected.entries()) {
        // 同一目标写两遍会让 recall 的分母虚高，看上去像"漏召回"
        if (c.expected.slice(0, j).some((o) => o.docId === t.docId && o.seq === t.seq)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['cases', i, 'expected', j],
            message: '期望命中里有重复目标'
          })
        }
      }
    }
  })

export type KbEvalTarget = z.infer<typeof targetSchema>
export type KbEvalCase = z.infer<typeof caseSchema>
export type KbEvalSet = z.infer<typeof kbEvalSetSchema>

/** 检索结果里指标需要看到的两列（RetrievedChunk 结构上兼容） */
export interface RankedHit {
  docId: string
  seq: number
}

/**
 * 反序列化：坏 JSON、版本不符、字段越界都抛带路径的中文错误。
 * 故意不"宽容处理"（比如补默认值）——一份残缺的卷子算出来的分毫无意义，必须当场拒绝。
 */
export function parseKbEvalSet(text: string): KbEvalSet {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new Error(`评测集不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
  const parsed = kbEvalSetSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const where = first?.path?.length ? first.path.join('.') : '（顶层）'
    throw new Error(`评测集格式不符：${where} — ${first?.message ?? '字段校验失败'}`)
  }
  return parsed.data
}

/** 序列化：键序稳定，方便 diff 与入库版本管理 */
export function stringifyKbEvalSet(set: KbEvalSet): string {
  return JSON.stringify(
    {
      version: set.version,
      kbId: set.kbId,
      name: set.name,
      cases: set.cases.map((c) => ({
        id: c.id,
        query: c.query,
        expected: c.expected.map((t) => (t.seq === undefined ? { docId: t.docId } : { docId: t.docId, seq: t.seq })),
        ...(c.note ? { note: c.note } : {})
      }))
    },
    null,
    2
  )
}

/**
 * 找出引用了不存在文档的目标。
 * 返回用例 id + docId + 该用例的标题，供界面直接列成「这几条已失效」。
 */
export function findStaleTargets(
  set: KbEvalSet,
  knownDocIds: Iterable<string>
): Array<{ caseId: string; docId: string }> {
  const known = new Set(knownDocIds)
  const out: Array<{ caseId: string; docId: string }> = []
  for (const c of set.cases) {
    for (const t of c.expected) {
      if (!known.has(t.docId)) out.push({ caseId: c.id, docId: t.docId })
    }
  }
  return out
}

export interface CaseResult {
  caseId: string
  /** 期望目标总数（分母） */
  expected: number
  /** 前 k 名内命中的目标数 */
  matched: number
  /** 第一个命中的名次（1 起）；整条没命中为 null */
  firstRank: number | null
  recallAtK: number
  /** 期望里的分块级目标在该文档没有分块进入前 k 时算漏；文档级目标只看 docId */
  missing: KbEvalTarget[]
}

/** 命中判定：文档级只要 docId 对上；分块级要 docId 与 seq 都对上 */
function hitIndex(hits: RankedHit[], t: KbEvalTarget, k: number): number | null {
  const limit = Math.min(k, hits.length)
  for (let i = 0; i < limit; i++) {
    const h = hits[i]!
    if (h.docId === t.docId && (t.seq === undefined || h.seq === t.seq)) return i + 1
  }
  return null
}

/**
 * 单条用例判分。`hits` 必须是**有序**的检索结果（第 0 位是第一名）。
 * k 截断是刻意的：评测问的是「注入前 k 条时够不够用」，不是「资料库里有没有」。
 */
export function evaluateCase(kbCase: KbEvalCase, hits: RankedHit[], k: number): CaseResult {
  const ranks = kbCase.expected.map((t) => hitIndex(hits, t, k))
  const matched = ranks.filter((r) => r !== null).length
  const firstRank = ranks.reduce<number | null>((acc, r) => (r === null ? acc : acc === null ? r : Math.min(acc, r)), null)
  return {
    caseId: kbCase.id,
    expected: kbCase.expected.length,
    matched,
    firstRank,
    recallAtK: matched / kbCase.expected.length,
    missing: kbCase.expected.filter((_, i) => ranks[i] === null)
  }
}

export interface EvalSummary {
  k: number
  cases: number
  /** 一条期望都没命中的用例数——用户最该先看这个 */
  missedCases: number
  /** 平均 recall@k */
  recallAtK: number
  /** 平均倒数排名（MRR）：命中排在第几名的综合刻度 */
  mrr: number
  /** 有命中的用例里第一名的中位名次；全漏则为 null */
  medianRank: number | null
  perCase: CaseResult[]
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2
}

/**
 * 汇总整份卷子。空 cases 直接返回零值而不是 NaN——运行器拿到空集要能显示"没测"，
 * 不能显示"recall 0.00"这种看着像结果的数。
 */
export function summarizeEval(set: KbEvalSet, run: Record<string, RankedHit[]>, k: number): EvalSummary {
  const perCase = set.cases.map((c) => evaluateCase(c, run[c.id] ?? [], k))
  const ranks = perCase.map((r) => r.firstRank).filter((r): r is number => r !== null)
  return {
    k,
    cases: perCase.length,
    missedCases: perCase.filter((r) => r.matched === 0).length,
    recallAtK: perCase.length ? perCase.reduce((sum, r) => sum + r.recallAtK, 0) / perCase.length : 0,
    mrr: perCase.length ? perCase.reduce((sum, r) => sum + (r.firstRank === null ? 0 : 1 / r.firstRank), 0) / perCase.length : 0,
    medianRank: median(ranks),
    perCase
  }
}

// ---------- 运行器的输出契约（主进程算，渲染层只排版）----------

/** 本次检索实际返回的片段（带 docId/seq/标题）：让用户能照着真 id 去改下一版卷子 */
export interface KbEvalReturned {
  docId: string
  seq: number
  title: string
}

export interface KbEvalRow {
  caseId: string
  query: string
  expected: number
  matched: number
  firstRank: number | null
  recallAtK: number
  /** 没进前 k 名的期望目标 */
  missing: KbEvalTarget[]
  returned: KbEvalReturned[]
}

export interface KbEvalMetrics {
  k: number
  cases: number
  missedCases: number
  recallAtK: number
  mrr: number
  medianRank: number | null
}

export interface KbEvalRunResult {
  /** 卷子里的名字（不是界面上选的库） */
  name: string
  kbId: string
  fileName: string
  metrics: KbEvalMetrics
  rows: KbEvalRow[]
  /** 期望引用了库里已不存在的文档 ⇒ 这份分数是在坏卷子上算的 */
  stale: Array<{ caseId: string; docId: string }>
  /** 期望引用的文档存在但被停用了（不参与检索）——不是失效，但一定漏 */
  disabledTargets: Array<{ caseId: string; docId: string; title: string }>
  /** 跑这份卷子前就该知道的坏消息（如：该库没配 embedding，向量路不参与） */
  warnings: string[]
  elapsedMs: number
}

/** 指标从 EvalSummary 摘出来（去掉 perCase——逐条明细在 rows 里给，别在同一份载荷里出现两遍） */
export function toEvalMetrics(s: EvalSummary): KbEvalMetrics {
  return { k: s.k, cases: s.cases, missedCases: s.missedCases, recallAtK: s.recallAtK, mrr: s.mrr, medianRank: s.medianRank }
}
