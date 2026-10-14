// 评测集运行器：真库、真检索、真判分（V4-Iter-137）
//
// 为什么必须用真库跑：这份代码的全部价值是"分数算得对不对"，而它踩在三层既有实现上——
// 检索融合顺序（RRF）、MMR 的多样性改序、文档级停用过滤。把它们桩掉，测的就只是"我调用了我桩的东西"。
// 这里只替 `embedQuery`（要打远程 embedding API），其余全真：临时 SQLite、真 FTS、真向量、真 ragService。
//
// 语料刻意用**互相正交**的单位向量：这样 MMR 的多样性惩罚对每条候选都一样（与第一名相似度都是 0），
// 名次就由融合分决定 ⇒ 期望的 firstRank 是可以手算的，不是抄运行结果的。
// 语料三条单位向量与查询的余弦是 1 / 0.8 / 0.6，无并列名次；x0 的正文含查询 ⇒ 它双路命中，融合分是另外两条的 2 倍。
// 名次要**手算核对**，而且 k 不同结果就不同：k=3 时池子刚好 3 条，`mmrSelect` 的
// 「候选数 ≤ 请求数就直接返回原序」短路生效 ⇒ 名次是融合序（Y 第 3）；k=2 时多样性才真的跑，
// 相关性差距（归一化后只有 0.015）压不过相似度惩罚（0.8 vs 0.6）⇒ Y 升到第 2。
// 这正是"期望目标要能写文档级也能写分块级"的原因，也是运行器必须跑真检索而不是喂假结果的原因。
// 查询串刻意用 3 字：FTS 是 trigram 分词，2 字中文查询恒空命中（SEC-18 已记），
// 用 2 字就只剩向量一路，测不到融合顺序。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-eval-run'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext', setFile: dir + sep + 'set.json' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

/** 查询向量替身：真 embedQuery 要打远程 API */
const H = vi.hoisted(() => ({ queryVec: new Float32Array([1, 0, 0]) }))
vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async () => H.queryVec,
  embedTexts: async () => []
}))

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'
import { runKbEvalSet } from '../src/main/knowledge/kb-eval-runner'
import { stringifyKbEvalSet, type KbEvalSet } from '../src/shared/kb-eval'

const v = (x: number, y: number, z: number) => new Float32Array([x, y, z])
let DOC_X = ''
let DOC_Y = ''
let DOC_Z = ''

/** 一份四题的卷子：X 文档级 / Y 分块级 / Z 已停用 / ghost 已失效 */
function buildSet(kbId = 'kbE'): KbEvalSet {
  return {
    version: 1,
    kbId,
    name: '退款政策评测',
    cases: [
      { id: 'c1', query: '退款额', expected: [{ docId: DOC_X }] },
      { id: 'c2', query: '退款额', expected: [{ docId: DOC_Y, seq: 0 }] },
      { id: 'c3', query: '退款额', expected: [{ docId: DOC_Z }] },
      { id: 'c4', query: '退款额', expected: [{ docId: 'ghost-doc' }] }
    ]
  }
}

function writeSet(set: KbEvalSet): string {
  fs.writeFileSync(P.setFile, stringifyKbEvalSet(set), 'utf8')
  return P.setFile
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  kbRepo.save({
    id: 'kbE',
    name: 'kbE',
    embeddingProviderId: 'p1',
    embeddingModel: 'm1',
    chunkSize: 800,
    chunkOverlap: 200,
    topK: 5,
    topN: 3,
    minScore: 0
  })
  const x = kbDocRepo.insert({ kbId: 'kbE', source: 'x.txt', sourceType: 'txt', title: '退款主文' })
  const y = kbDocRepo.insert({ kbId: 'kbE', source: 'y.txt', sourceType: 'txt', title: '运费说明' })
  const z = kbDocRepo.insert({ kbId: 'kbE', source: 'z.txt', sourceType: 'txt', title: '已停用文档' })
  DOC_X = x.id
  DOC_Y = y.id
  DOC_Z = z.id
  kbChunkRepo.insertMany([
    { id: 'c-x0', docId: x.id, kbId: 'kbE', sequence: 0, content: '退款额说明', embedding: v(1, 0, 0) },
    { id: 'c-x1', docId: x.id, kbId: 'kbE', sequence: 1, content: '附录', embedding: v(0.8, 0.6, 0) },
    { id: 'c-y0', docId: y.id, kbId: 'kbE', sequence: 0, content: '运费', embedding: v(0.6, 0.8, 0) },
    { id: 'c-z0', docId: z.id, kbId: 'kbE', sequence: 0, content: '退款额停用', embedding: v(1, 0, 0) }
  ])
  kbDocRepo.setEnabled(z.id, false)
  writeSet(buildSet())
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('逐条跑真检索并算指标', () => {
  it('k=3（缺省取该库 topN）：四题的 recall / MRR / 中位名次 / 漏召回数与手算一致', async () => {
    const r = await runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })
    // 名次：c1 → X 第 1 名；c2 → Y 第 **3** 名；c3 停用文档永不返回；c4 目标不存在。
    // 为什么是第 3 而 k=2 那条例用例里 Y 是第 2：`mmrSelect` 在「候选数 ≤ 请求数」时直接短路返回原序，
    // k=3 时池子刚好 3 条 ⇒ 多样性从没跑过，名次就是融合分序（x0 双路命中 > x1 > y0）。
    expect(r.metrics.k).toBe(3)
    expect(r.rows.map((x) => [x.caseId, x.matched, x.firstRank])).toEqual([
      ['c1', 1, 1],
      ['c2', 1, 3],
      ['c3', 0, null],
      ['c4', 0, null]
    ])
    expect(Number(r.metrics.recallAtK.toFixed(4))).toBe(0.5)
    // MRR = (1 + 1/3 + 0 + 0) / 4；中位名次取有命中的两条 (1,3) ⇒ 2
    expect(Number(r.metrics.mrr.toFixed(4))).toBe(0.3333)
    expect(r.metrics.medianRank).toBe(2)
    expect(r.metrics.missedCases).toBe(2)
    expect(r.metrics.cases).toBe(4)
    expect(r.name).toBe('退款政策评测')
    expect(r.fileName).toBe('set.json')
  })

  it('k 覆盖成 1：只返回第一名，recall 与漏召回数随之变化（问的就是"注入前 k 条够不够"）', async () => {
    const r = await runKbEvalSet({ kbId: 'kbE', filePath: P.setFile, k: 1 })
    expect(r.metrics.k).toBe(1)
    expect(r.rows.map((x) => x.recallAtK)).toEqual([1, 0, 0, 0])
    expect(Number(r.metrics.recallAtK.toFixed(4))).toBe(0.25)
    expect(r.metrics.missedCases).toBe(3)
    expect(r.metrics.medianRank).toBe(1)
  })

  it('每行都带「实际返回了什么」的真 docId/seq/标题，用户能照着改下一版卷子', async () => {
    const r = await runKbEvalSet({ kbId: 'kbE', filePath: P.setFile, k: 2 })
    // 前两名是 X#0 与 Y#0（同一篇文档的第二个分块被 MMR 挤到第三名）——k 变小就把 Y 挡在外面的是名次而不是资料库
    expect(r.rows[0]!.returned.map((x) => [x.title, x.seq])).toEqual([['退款主文', 0], ['运费说明', 0]])
    expect(r.rows[0]!.returned[1]!.docId).toBe(DOC_Y)
    expect(r.rows[1]!.recallAtK).toBe(1) // Y 就在第 2 名
    expect(r.rows[2]!.missing).toEqual([{ docId: DOC_Z }])
  })

  it('失效目标与停用目标分别列出，并给出"分数是在坏卷子上算的"这句警告', async () => {
    const r = await runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })
    expect(r.stale).toEqual([{ caseId: 'c4', docId: 'ghost-doc' }])
    expect(r.disabledTargets).toEqual([{ caseId: 'c3', docId: DOC_Z, title: '已停用文档' }])
    expect(r.warnings.some((w) => w.includes('坏卷子'))).toBe(true)
  })

  it('没配 embedding 的库要如实说明：这份分数只反映全文检索', async () => {
    kbRepo.save({ id: 'kbNoEmb', name: 'kbNoEmb', chunkSize: 800, chunkOverlap: 200, topK: 5, topN: 3, minScore: 0 })
    const d = kbDocRepo.insert({ kbId: 'kbNoEmb', source: 'n.txt', sourceType: 'txt', title: '只有全文' })
    kbChunkRepo.insertMany([{ id: 'c-n0', docId: d.id, kbId: 'kbNoEmb', sequence: 0, content: '退款额说明', embedding: v(1, 0, 0) }])
    const file = writeSet({ version: 1, kbId: 'kbNoEmb', name: '全文卷子', cases: [{ id: 'q1', query: '退款额', expected: [{ docId: d.id }] }] })
    const r = await runKbEvalSet({ kbId: 'kbNoEmb', filePath: file })
    expect(r.warnings.some((w) => w.includes('没有配置 Embedding'))).toBe(true)
    expect(r.metrics.recallAtK).toBe(1)
  })
})

describe('坏卷子与错库要当场拒绝', () => {
  it('卷子绑定的库与选中的库不一致 ⇒ 中文报错，不静默按当前库跑', async () => {
    const file = writeSet(buildSet('别的库'))
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: file })).rejects.toThrow(/为库「别的库」出的/)
  })

  it('坏 JSON / 结构不符 ⇒ 带路径的中文错误（不"宽容补默认值"）', async () => {
    fs.writeFileSync(P.setFile, '{ not json', 'utf8')
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })).rejects.toThrow(/不是合法的 JSON/)

    fs.writeFileSync(P.setFile, JSON.stringify({ version: 1, kbId: 'kbE', name: 'x', cases: [] }), 'utf8')
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })).rejects.toThrow(/评测集格式不符/)

    // 期望为空 = 这条用例永远满分，是最坏的假绿：schema 层就得拦住，运行器不许放行
    fs.writeFileSync(
      P.setFile,
      JSON.stringify({
        version: 1,
        kbId: 'kbE',
        name: 'x',
        cases: [{ id: 'c1', query: '退款', expected: [{ docId: DOC_X }, { docId: DOC_X }] }]
      }),
      'utf8'
    )
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })).rejects.toThrow(/重复目标/)
  })

  it('空期望的用例连文件都进不来；写进路径里也不许绕过', async () => {
    fs.writeFileSync(
      P.setFile,
      JSON.stringify({ version: 1, kbId: 'kbE', name: 'x', cases: [{ id: 'c1', query: '退款', expected: [] }] }),
      'utf8'
    )
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })).rejects.toThrow(/cases\.0\.expected/)
  })

  it('选到目录或超大文件都要给出可读报错，而不是把主进程拖去啃 2 MB 以上', async () => {
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: P.dir })).rejects.toThrow(/不是一个文件/)
    fs.writeFileSync(P.setFile, JSON.stringify({ ...buildSet(), name: 'x'.repeat(3 * 1024 * 1024) }), 'utf8')
    await expect(runKbEvalSet({ kbId: 'kbE', filePath: P.setFile })).rejects.toThrow(/超过 2 MB 上限/)
    writeSet(buildSet())
  })

  it('不存在的库 ⇒ 明确报错（不是返回一份空结果装作跑完了）', async () => {
    await expect(runKbEvalSet({ kbId: 'nope', filePath: P.setFile })).rejects.toThrow(/知识库不存在/)
  })
})
