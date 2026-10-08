// FTS5 查询串构造（SEC-18）
//
// 问题：kb_chunks_fts 用 tokenize='trigram'，索引侧是 3 字符 gram，而旧的 bm25Search 按
// 空白切词后把整段查询包成短语 —— 中文整句成为一个短语，要求「连续原文子串」存在才命中，
// 自然语言问句几乎恒为 0 命中（向量路独扛，混合检索退化成单路）。
//
// 做法（纯查询侧，**不需要重建索引**，以下均为对本机 sqlite 的实测结论）：
// - 拉丁/数字词按原样整词匹配（trigram 会把它拆成 gram 并做顺序拼接，"BM25" 可命中）；
// - CJK 连续段切成 3 字滑窗，窗口之间 OR —— 命中越多 gram 的片段 bm25 排名越靠前（实测）；
// - 长度 1-2 的 CJK 段不产出 FTS 词项：trigram 短语要求 ≥3 字符，实测 2 字短语恒空；
//   也不退化去 LIKE 兜底——实测 LIKE '%库%'（1 字）在 trigram 表上被索引加速后**静默返回空**，
//   比报错更糟；这类短查询交给向量路。
// - 所有词项都用双引号包裹并对内嵌引号加倍转义，避免用户输入改变 MATCH 语法。

/** 单次查询最多产出的 CJK 三元组数（防长句产出上百个词项撑大查询串） */
export const MAX_FTS_TERMS = 32
/** trigram 索引的最小可匹配长度 */
const TRIGRAM_MIN = 3

/** CJK 及全角标点范围（与 engine 的 token 估算口径一致，另含日文假名） */
const CJK_RE = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/

/** 词项加引号并转义内嵌双引号 */
function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`
}

/** 从一段连续 CJK 文本产出 3 字滑窗（长度 <3 的段产不出词项，返回空） */
function cjkTrigrams(run: string, budget: number): string[] {
  const chars = [...run]
  if (chars.length < TRIGRAM_MIN) return []
  const out: string[] = []
  for (let i = 0; i + TRIGRAM_MIN <= chars.length && out.length < budget; i++) {
    out.push(chars.slice(i, i + TRIGRAM_MIN).join(''))
  }
  return out
}

/**
 * 把用户查询编译成 FTS5 MATCH 表达式；无可用的词项时返回 null（调用方跳过 BM25 路）。
 * 结果去重并保持出现顺序，词项总数受 MAX_FTS_TERMS 约束。
 */
export function buildFtsMatchQuery(query: string, maxTerms = MAX_FTS_TERMS): string | null {
  const raw = String(query ?? '').trim()
  if (!raw) return null

  const terms: string[] = []
  const seen = new Set<string>()
  const push = (t: string): void => {
    const v = t.trim()
    if (!v || seen.has(v)) return
    seen.add(v)
    terms.push(v)
  }

  // 按 CJK / 非 CJK 边界切段：非 CJK 段再按空白与标点分词
  const segments = raw.split(/([\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]+)/)
  for (const seg of segments) {
    if (!seg) continue
    if (CJK_RE.test(seg)) {
      for (const g of cjkTrigrams(seg, maxTerms - terms.length)) push(g)
      continue
    }
    // 先按空白切，再剥首尾标点：保留词内 - _ .（版本号角标如 "gpt-4"、"BM25"、"v1.2"）
    for (const raw of seg.split(/\s+/)) {
      const word = raw.replace(/^[\p{P}\p{S}]+/u, '').replace(/[\p{P}\p{S}]+$/u, '')
      if (word) push(word)
    }
    if (terms.length >= maxTerms) break
  }

  const usable = terms.filter((t) => !CJK_RE.test(t) || [...t].length >= TRIGRAM_MIN)
  if (usable.length === 0) return null
  return usable.slice(0, maxTerms).map(quote).join(' OR ')
}
