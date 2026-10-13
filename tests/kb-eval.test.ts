// 知识库评测集的数据结构与指标（V4-Iter-128）
//
// 这批只做"数据结构 + 判分"，运行入口留到下一批，所以这里全部是纯函数用例。
// 最要命的两件事专门盯着：① 期望目标只能用 docId / docId+seq（chunkId 每次重索引都会变）；
// ② 卷子失效了必须查得出来——否则指标是在一份坏卷子上算分，越看越安心。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  KB_EVAL_FILE_VERSION,
  parseKbEvalSet,
  stringifyKbEvalSet,
  findStaleTargets,
  evaluateCase,
  summarizeEval,
  type KbEvalCase,
  type KbEvalSet,
  type RankedHit
} from '../src/shared/kb-eval'

const set = (over: Partial<KbEvalSet> = {}): KbEvalSet => ({
  version: KB_EVAL_FILE_VERSION,
  kbId: 'kb1',
  name: '退款政策评测',
  cases: [
    { id: 'q1', query: '退款期限是几天', expected: [{ docId: 'dA' }] },
    { id: 'q2', query: '生鲜能退吗', expected: [{ docId: 'dB', seq: 2 }, { docId: 'dB', seq: 5 }] }
  ],
  ...over
})

const hits = (...pairs: Array<[string, number]>): RankedHit[] => pairs.map(([docId, seq]) => ({ docId, seq }))

describe('parseKbEvalSet / stringifyKbEvalSet', () => {
  it('合法文件解析通过，写出再读回内容不变（往返稳定）', () => {
    const s = set()
    const text = stringifyKbEvalSet(s)
    expect(parseKbEvalSet(text)).toEqual(s)
  })

  it('省略 seq 的目标不会被补成 seq: undefined（写出的是干净形状）', () => {
    const text = stringifyKbEvalSet(set())
    expect(text).not.toContain('undefined')
    expect(JSON.parse(text).cases[0].expected[0]).toEqual({ docId: 'dA' })
  })

  it('坏 JSON 报错说明是 JSON 问题，不是格式问题', () => {
    expect(() => parseKbEvalSet('{oops')).toThrow(/不是合法的 JSON/)
  })

  it('版本号不符必须拒绝（旧卷子的结构不保证还能算对）', () => {
    const bad = { ...set(), version: KB_EVAL_FILE_VERSION + 1 }
    expect(() => parseKbEvalSet(JSON.stringify(bad))).toThrow(/评测集格式不符.*version/)
  })

  it('缺 expected / expected 空数组被拒（一条期望都没有的用例永远满分，是最坏的假绿）', () => {
    expect(() => parseKbEvalSet(JSON.stringify({ ...set(), cases: [{ id: 'q', query: 'x' }] }))).toThrow()
    const emptyExpected = { id: 'q', query: 'x', expected: [] }
    expect(() => parseKbEvalSet(JSON.stringify({ ...set(), cases: [emptyExpected] }))).toThrow(/expected/)
  })

  it('未知字段被拒（strict）：手写的 expect_chunk_ids 之类不会静默失效', () => {
    const oops = JSON.parse(stringifyKbEvalSet(set()))
    oops.cases[0].expect_chunk_ids = ['c1']
    expect(() => parseKbEvalSet(JSON.stringify(oops))).toThrow()
  })

  it('用例 id 重复被拒', () => {
    const dup = { ...set(), cases: [set().cases[0]!, { ...set().cases[1]!, id: 'q1' }] }
    expect(() => parseKbEvalSet(JSON.stringify(dup))).toThrow(/id 重复/)
  })

  it('同一条用例里重复写同一个期望目标被拒（分母虚高会被当成漏召回）', () => {
    const dup = { ...set(), cases: [{ id: 'q1', query: 'x', expected: [{ docId: 'dA' }, { docId: 'dA' }] }] }
    expect(() => parseKbEvalSet(JSON.stringify(dup))).toThrow(/重复目标/)
  })

  it('空 cases、空 kbId、超长 query 都被拒', () => {
    expect(() => parseKbEvalSet(JSON.stringify({ ...set(), cases: [] }))).toThrow()
    expect(() => parseKbEvalSet(JSON.stringify({ ...set(), kbId: '' }))).toThrow()
    expect(() => parseKbEvalSet(JSON.stringify({ ...set(), cases: [{ id: 'q', query: 'x'.repeat(4001), expected: [{ docId: 'd' }] }] }))).toThrow()
  })
})

describe('findStaleTargets — 卷子失效要查得出来', () => {
  it('引用了不存在的文档 ⇒ 逐条列出用例与 docId', () => {
    const stale = findStaleTargets(set(), ['dA', 'dC'])
    // q1 的 dA 在；q2 的两个目标都指向已被删掉的 dB
    expect(stale).toEqual([
      { caseId: 'q2', docId: 'dB' },
      { caseId: 'q2', docId: 'dB' }
    ])
  })

  it('文档都在 ⇒ 空数组（不是 undefined，界面据此显示"没有失效用例"）', () => {
    expect(findStaleTargets(set(), ['dA', 'dB'])).toEqual([])
  })
})

describe('evaluateCase — 单条判分', () => {
  const docCase: KbEvalCase = { id: 'q1', query: '退款期限', expected: [{ docId: 'dA' }] }
  const chunkCase: KbEvalCase = { id: 'q2', query: '生鲜', expected: [{ docId: 'dB', seq: 2 }] }

  it('文档级：该文档任一分块进入就算命中，firstRank 是它的名次（1 起）', () => {
    const r = evaluateCase(docCase, hits(['dX', 0], ['dA', 7]), 5)
    expect(r.matched).toBe(1)
    expect(r.firstRank).toBe(2)
    expect(r.recallAtK).toBe(1)
    expect(r.missing).toEqual([])
  })

  it('分块级：docId 对上但 seq 不对 ⇒ 不算命中（这才是"精确到块"的意义）', () => {
    const r = evaluateCase(chunkCase, hits(['dB', 3]), 5)
    expect(r.matched).toBe(0)
    expect(r.firstRank).toBeNull()
    expect(r.missing).toEqual([{ docId: 'dB', seq: 2 }])
  })

  it('k 截断：第 k 名之后出现的期望目标算漏（评测问的是"注入前 k 条够不够"）', () => {
    expect(evaluateCase(docCase, hits(['dX', 0], ['dA', 1]), 2).matched).toBe(1)
    expect(evaluateCase(docCase, hits(['dX', 0], ['dX', 1], ['dA', 2]), 2).matched).toBe(0)
  })

  it('多目标：recall 是命中比例，firstRank 取最靠前那个', () => {
    const multi: KbEvalCase = { id: 'q3', query: 'x', expected: [{ docId: 'dA' }, { docId: 'dB' }, { docId: 'dC' }] }
    const r = evaluateCase(multi, hits(['dB', 0], ['dX', 0], ['dC', 4]), 5)
    expect(r.expected).toBe(3)
    expect(r.matched).toBe(2)
    expect(r.recallAtK).toBeCloseTo(2 / 3, 10)
    expect(r.firstRank).toBe(1)
    expect(r.missing).toEqual([{ docId: 'dA' }])
  })
})

describe('summarizeEval — 整份卷子', () => {
  it('recall@k / missedCases / mrr / medianRank 逐个对得上', () => {
    const s = set()
    const run = { q1: hits(['dA', 0]), q2: hits(['dX', 0], ['dB', 2], ['dB', 5]) }
    const sum = summarizeEval(s, run, 5)
    expect(sum.k).toBe(5)
    expect(sum.cases).toBe(2)
    expect(sum.missedCases).toBe(0)
    expect(sum.recallAtK).toBe(1)
    // q1 第一名、q2 第二名 ⇒ mrr = (1 + 1/2)/2
    expect(sum.mrr).toBeCloseTo(0.75, 10)
    expect(sum.medianRank).toBeCloseTo(1.5, 10)
  })

  it('一条全漏 ⇒ missedCases 计入、该条 mrr 贡献 0、不影响 medianRank 的取值范围', () => {
    const sum = summarizeEval(set(), { q1: hits(['nope', 0]), q2: hits(['nope', 0]) }, 5)
    expect(sum.missedCases).toBe(2)
    expect(sum.recallAtK).toBe(0)
    expect(sum.mrr).toBe(0)
    expect(sum.medianRank).toBeNull()
  })

  it('运行器漏喂某条用例的结果 ⇒ 当"没检索到"处理，而不是把整份汇总算崩（NaN）', () => {
    const sum = summarizeEval(set(), { q1: hits(['dA', 0]) }, 5)
    expect(sum.cases).toBe(2)
    expect(Number.isNaN(sum.recallAtK)).toBe(false)
    expect(sum.recallAtK).toBeCloseTo(0.5, 10)
    expect(sum.missedCases).toBe(1)
  })

  it('空卷面返回零值而不是 NaN（界面能显示"没测"，而不是看着像 recall 0.00）', () => {
    const sum = summarizeEval({ ...set(), cases: [] }, {}, 5)
    expect(sum.cases).toBe(0)
    expect(sum.recallAtK).toBe(0)
    expect(sum.mrr).toBe(0)
    expect(sum.medianRank).toBeNull()
    expect(sum.perCase).toEqual([])
  })

  it('中位数奇偶都算对（偶数取中间两数平均）', () => {
    const s: KbEvalSet = {
      version: KB_EVAL_FILE_VERSION,
      kbId: 'kb1',
      name: 'n',
      cases: [1, 2, 3, 4].map((i) => ({ id: `q${i}`, query: 'x', expected: [{ docId: `d${i}` }] }))
    }
    const run = {
      q1: hits(['d1', 0]),
      q2: hits(['x', 0], ['d2', 0]),
      q3: hits(['x', 0], ['x', 1], ['d3', 0]),
      q4: hits(['x', 0], ['x', 1], ['x', 2], ['d4', 0])
    }
    expect(summarizeEval(s, run, 5).medianRank).toBeCloseTo(2.5, 10)
  })
})

describe('示例评测集文件（tests/fixtures/kb-eval-sample.json）', () => {
  it('示例文件本身必须能解析通过——文档给人抄的东西坏掉是最坑的', () => {
    const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'kb-eval-sample.json'), 'utf8')
    const s = parseKbEvalSet(text)
    expect(s.cases).toHaveLength(3)
    expect(s.cases[1]!.expected[0]?.seq).toBe(2)
    // 文档里给人抄的示例要自洽：它引用的 docId 全都能在自己列出的文档里找到
    const known = s.cases.flatMap((c) => c.expected.map((t) => t.docId))
    expect(findStaleTargets(s, known)).toEqual([])
  })
})
