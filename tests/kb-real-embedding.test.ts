// 真模型、真库、真向量、真全文索引：把 B60 / B63 / B64 / B65 的**行为半边**在真 embedding 上验一遍
//
// 为什么值得单开一个文件：之前所有检索用例喂的都是手搓向量（同向=1、正交=0），
// 那只能证明"接线对了"，证不了「阈值调到多少真的能挡住无关片段」——
// 因为假向量的相似度是我编的。这里换成随包内置的本地模型 `Xenova/bge-small-zh-v1.5`
// （`local-embedding.ts` 强制 `allowRemoteModels=false`，全程离线），数字是模型给的。
//
// 实测分布（dim=512，sqlite-vec 已启用；这些数是探针跑出来的，断言按实测边界写）：
//   「退款期限是几天」      → 0.716 / 0.527 / 0.408 / 0.317 / 0.248 / 0.192
//   「打印机连不上怎么办」  → 打印机两块 0.609 / 0.578，其余 ≤0.392
//   「完全无关的火星殖民计划」→ **最高只有 0.318**
//   ⇒ 结论：这套语料上 0.35 正好卡在"无关查询的天花板"之上，0.5 只留同话题片段。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const MODEL_DIR = path.resolve(process.cwd(), 'resources/models/Xenova/bge-small-zh-v1.5')
const HAS_MODEL = fs.existsSync(path.join(MODEL_DIR, 'onnx/model_quantized.onnx'))

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-real-embed'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

// electron 只为拿到 cwd（dev 分支的模型路径就是 process.cwd()/resources/models）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))
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

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'
import { embedTexts } from '../src/main/knowledge/embedding'
import { ragService } from '../src/main/knowledge/rag'
import { chunksToSources } from '../src/shared/kb-sources'
import { clearPerfEvents, getRecentPerf } from '../src/main/steward/perf-probe'
import { BUILTIN_EMBED_PROVIDER_ID, BUILTIN_EMBED_MODEL } from '../src/shared/types'

const TEXTS = [
  '下单 7 天内可申请全额退款',
  '生鲜类商品不支持退款',
  '打印机驱动安装与 USB 配对步骤',
  '无线网络打印机的配置方法',
  'Q3 销售目标与人员安排',
  '会议决定推迟发布节奏'
]

/** chunkId → 语料下标，断言里用来还原作者期望 */
const idOf = (i: number): string => `p${i}`

let docRefundId = ''

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()

  // 真模型批量向量化（第一次调用会初始化 pipeline）
  const vecs = await embedTexts(BUILTIN_EMBED_PROVIDER_ID, BUILTIN_EMBED_MODEL, TEXTS)
  expect(vecs[0]!.length).toBe(512)

  kbRepo.save({
    id: 'kbReal',
    name: 'kbReal',
    embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID,
    embeddingModel: BUILTIN_EMBED_MODEL,
    topK: 20,
    topN: 6,
    minScore: 0
  })
  kbRepo.save({ id: 'kbNoVec', name: 'kbNoVec', topK: 20, topN: 6, minScore: 0.5 })

  const d1 = kbDocRepo.insert({ kbId: 'kbReal', source: 'refund.txt', sourceType: 'txt', title: '退款政策' })
  const d2 = kbDocRepo.insert({ kbId: 'kbReal', source: 'ops.txt', sourceType: 'txt', title: '其它资料' })
  docRefundId = d1.id
  kbChunkRepo.insertMany([
    { id: idOf(0), docId: d1.id, kbId: 'kbReal', sequence: 0, content: TEXTS[0]!, embedding: vecs[0]! },
    { id: idOf(1), docId: d1.id, kbId: 'kbReal', sequence: 1, content: TEXTS[1]!, embedding: vecs[1]! },
    { id: idOf(2), docId: d2.id, kbId: 'kbReal', sequence: 0, content: TEXTS[2]!, embedding: vecs[2]! },
    { id: idOf(3), docId: d2.id, kbId: 'kbReal', sequence: 1, content: TEXTS[3]!, embedding: vecs[3]! },
    { id: idOf(4), docId: d2.id, kbId: 'kbReal', sequence: 2, content: TEXTS[4]!, embedding: vecs[4]! },
    { id: idOf(5), docId: d2.id, kbId: 'kbReal', sequence: 3, content: TEXTS[5]!, embedding: vecs[5]! }
  ])
  // 无向量的库：只塞全文（阈值设了但算不出相似度，应当跳过过滤并留痕）
  const d3 = kbDocRepo.insert({ kbId: 'kbNoVec', source: 'plain.txt', sourceType: 'txt', title: '纯文本库' })
  dbService
    .getHandle()
    .prepare(
      `INSERT INTO kb_chunks (id, doc_id, kb_id, sequence, content, embedding, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`
    )
    .run('nv0', d3.id, 'kbNoVec', 0, '全额退款的说明段落', Date.now())
}, 180_000)

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  clearPerfEvents()
})

const simOf = (list: Array<{ chunkId: string; similarity?: number }>, id: string): number =>
  Number(list.find((c) => c.chunkId === id)?.similarity ?? -1)

describe.skipIf(!HAS_MODEL)('真 embedding 下的检索行为（B60/B63/B64/B65）', () => {
  it('模型给的相似度确实有区分度：同话题块显著高于跨话题块（不是手搓出来的）', async () => {
    const { result } = await ragService.retrieveWithDiagnostics(['kbReal'], '退款期限是几天')
    // 实测 0.716 / 0.527 / … / 0.192，跨话题的打印机块 0.248
    expect(result.chunks[0]!.chunkId).toBe(idOf(0))
    expect(simOf(result.chunks, idOf(0))).toBeGreaterThan(0.6)
    expect(simOf(result.chunks, idOf(0)) - simOf(result.chunks, idOf(3))).toBeGreaterThan(0.3)
  })

  it('阈值 0.5 ⇒ 只留同话题的两块，其余四条被挡住（B64 ③④：挡的是内容，不是条数）', async () => {
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 6, minScore: 0.5 })
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbReal'], '退款期限是几天')
    expect(result.chunks.map((c) => c.chunkId).sort()).toEqual([idOf(0), idOf(1)])
    expect(diagnostics.filteredByThreshold).toBe(4)
    // 留下的每条都过线，且显示的就是判定用的那个数
    for (const c of result.chunks) expect(c.similarity! ).toBeGreaterThanOrEqual(0.5)
  })

  it('无关查询 + 阈值 0.35 ⇒ 一条都不注入（实测天花板 0.318，这正是 B4 要解决的问题）', async () => {
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 6, minScore: 0.35 })
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbReal'], '完全无关的火星殖民计划')
    expect(result.chunks).toEqual([])
    expect(diagnostics.filteredByThreshold).toBeGreaterThan(0)
    // 反向对照：同一个阈值下，真相关问题照样有注入
    const hit = await ragService.retrieveWithDiagnostics(['kbReal'], '生鲜能不能退')
    expect(hit.result.chunks.map((c) => c.chunkId)).toContain(idOf(1))
  })

  it('阈值 0.99 ⇒ 诚实返回空，不偷偷回退成不过滤', async () => {
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 6, minScore: 0.99 })
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbReal'], '退款期限是几天')
    expect(result.chunks).toEqual([])
    expect(diagnostics.filteredByThreshold).toBe(6)
    expect(diagnostics.vectorHits).toBeGreaterThan(0) // 检索本身是干活了的，只是都不够像
  })

  it('每库的 topN 决定注入条数（B60 ①③：真模型下也一样）', async () => {
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 2, minScore: 0 })
    const two = await ragService.retrieveWithDiagnostics(['kbReal'], '退款期限是几天')
    expect(two.result.chunks).toHaveLength(2)
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 6, minScore: 0 })
    const six = await ragService.retrieveWithDiagnostics(['kbReal'], '退款期限是几天')
    expect(six.result.chunks).toHaveLength(6)
  })

  it('embedding 服务商失效 ⇒ 记 vector 降级、全文路照常命中、perf 缓冲留一条 kb.degrade（B63 ①②③）', async () => {
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: 'ghost-provider', embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 6, minScore: 0 })
    try {
      const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbReal'], '全额退款')
      expect(diagnostics.degradations.map((d) => d.stage)).toContain('vector')
      expect(diagnostics.degradations[0]!.kbId).toBe('kbReal')
      expect(diagnostics.vectorHits).toBe(0)
      expect(diagnostics.bm25Hits).toBeGreaterThan(0) // 少一路不等于没结果
      expect(result.chunks.length).toBeGreaterThan(0)
      const details = getRecentPerf().filter((e) => e.label === 'kb.degrade').map((e) => e.detail ?? '')
      expect(details.some((d) => d.includes('stage=vector') && d.includes('kb=kbReal'))).toBe(true)
    } finally {
      kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 6, minScore: 0 })
    }
  })

  it('没配 embedding 的库设了阈值 ⇒ 记 threshold 降级并跳过过滤（不把资料判死）', async () => {
    const { result, diagnostics } = await ragService.retrieveWithDiagnostics(['kbNoVec'], '全额退款')
    expect(diagnostics.degradations.map((d) => d.stage)).toContain('threshold')
    expect(diagnostics.filteredByThreshold).toBe(0)
    expect(result.chunks.map((c) => c.chunkId)).toContain('nv0')
    // 没向量就没有相似度可显示——也不能出现假数
    expect(result.chunks.find((c) => c.chunkId === 'nv0')?.similarity).toBeUndefined()
  })

  it('引用来源带真 docId/kbId/seq，且 seq 就是文档内第几块（A2 在真库上的闭环）', async () => {
    kbRepo.save({ id: 'kbReal', name: 'kbReal', embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID, embeddingModel: BUILTIN_EMBED_MODEL, topK: 20, topN: 3, minScore: 0 })
    const res = await ragService.retrieve(['kbReal'], '生鲜能不能退') // retrieve 直接返回 RetrievalResult
    const sources = chunksToSources(res.chunks)
    expect(sources.length).toBeGreaterThan(0)
    const first = sources.find((s) => s.chunkId === idOf(1))!
    expect(first.kbId).toBe('kbReal')
    expect(first.docId).toBe(docRefundId)
    expect(first.seq).toBe(1) // p1 是退款文档的第 2 块
    expect(sources.every((s) => s.kbId !== undefined && s.seq !== undefined)).toBe(true)
  })
})
