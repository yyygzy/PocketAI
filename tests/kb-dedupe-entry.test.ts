// 重复入库拦在入口（V4-Iter-135）：同路径 / 同内容指纹都不再建第二份文档
//
// 为什么要这条：`kb_documents` 没有任何唯一约束（database.ts:128），两个添加入口
// （KB_DOC_ADD_FILE / KB_DOC_ADD_FOLDER）历史上是「对话框给几个路径就 insert 几篇」，
// 既不比路径也不比内容 ⇒ 同一个文件夹再导一次就是双份文档、双份解析、双份 embedding，
// 检索里还出现两条一模一样的注入片段。
// 策略：真临时库 + 真磁盘文件，只替掉「要打远程 API」的那几步（ingestion / indexQueue）。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-dedupe'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext', files: dir + sep + 'files' }
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

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.dir, getAppPath: () => P.dir, quit: () => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      H.handlers.set(ch, fn)
    },
    on: () => {}
  },
  dialog: {
    showOpenDialog: async () => ({ canceled: false, filePaths: [...H.dialogPaths] }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    showErrorBox: () => {}
  },
  BrowserWindow: class {
    static fromWebContents() {
      return undefined
    }
    static getAllWindows() {
      return []
    }
  },
  nativeImage: { createFromPath: () => ({}) },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

/** 入库与队列的替身：本文件测的是"要不要排队"，不是排队之后发生什么 */
const H = vi.hoisted(() => ({
  enqueued: [] as Array<{ kbId: string; docId: string; kind: string }>,
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  dialogPaths: [] as string[]
}))

vi.mock('../src/main/knowledge/index-queue', () => ({
  indexQueue: {
    enqueue: (t: { kbId: string; docId: string; kind: string }) => {
      H.enqueued.push(t)
      return { id: 'x' }
    },
    onTaskDone: () => () => {},
    isIdle: () => true,
    size: () => 0
  }
}))

vi.mock('../src/main/knowledge/ingestion', () => ({
  ingestionService: { ingestDocument: async () => undefined, ingestText: async () => undefined }
}))

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { planFileIngest } from '../src/main/knowledge/dedupe'
import { hashFile } from '../src/main/knowledge/sync-check'
import { registerKnowledgeHandlers } from '../src/main/ipc/handlers/knowledge'
import { IPC } from '../src/shared/types'
import type { KbDocument } from '../src/shared/types'

/** 写一个真文件并返回路径（内容决定指纹） */
function writeFile(name: string, content: string): string {
  const p = path.join(P.files, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

/** 模拟「库里已经索引过这篇」：insert 后写上 content_hash（ingestion 本来就是这么做的） */
function seedDoc(kbId: string, source: string, hash: string | null): string {
  const doc = kbDocRepo.insert({ kbId, source, sourceType: 'txt', title: source })
  if (hash !== null) kbDocRepo.setContentHash(doc.id, hash)
  return doc.id
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.files, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerKnowledgeHandlers()
  for (const id of ['kbA', 'kbB']) {
    kbRepo.save({
      id,
      name: id,
      embeddingProviderId: 'p1',
      embeddingModel: 'm1',
      chunkSize: 800,
      chunkOverlap: 200,
      topK: 10,
      topN: 5,
      minScore: 0
    })
  }
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  H.enqueued.length = 0
})

describe('planFileIngest：路径与内容两道闸', () => {
  it('库里已有同一路径 ⇒ 整批被拦，accepted 为空', async () => {
    const f = writeFile('a1.md', '甲内容')
    seedDoc('kbA', f, await hashFile(f))
    const plan = await planFileIngest('kbA', [f])
    expect(plan).toEqual({ accepted: [], skippedSameSource: 1, skippedSameContent: 0 })
  })

  it('路径不同但字节完全一样 ⇒ 按内容指纹拦住（文件被改名/复制成两份的常见形状）', async () => {
    const f = writeFile('a2.md', '乙内容')
    const plan1 = await planFileIngest('kbA', [f])
    expect(plan1.accepted).toEqual([f])
    // 模拟入库时写上了指纹
    seedDoc('kbA', f, await hashFile(f))
    const copy = writeFile('a2-副本.md', '乙内容')
    const plan2 = await planFileIngest('kbA', [copy])
    expect(plan2).toEqual({ accepted: [], skippedSameSource: 0, skippedSameContent: 1 })
  })

  it('内容真的不同 ⇒ 照常放行（闸门不许把新资料也挡了）', async () => {
    const f = writeFile('a3.md', '丙内容')
    seedDoc('kbA', f, await hashFile(f))
    const other = writeFile('a3-改写.md', '丙内容，多加了一行')
    const plan = await planFileIngest('kbA', [other])
    expect(plan.accepted).toEqual([other])
  })

  it('一次选择里同一路径出现两次 / 同一内容出现两份 ⇒ 只收第一篇', async () => {
    const f = writeFile('b1.md', '丁内容')
    const dup = writeFile('b2.md', '丁内容')
    const plan = await planFileIngest('kbA', [f, f, dup])
    expect(plan.accepted).toEqual([f])
    expect(plan.skippedSameSource).toBe(1)
    expect(plan.skippedSameContent).toBe(1)
    // 结构不变量：收下 + 跳过的必须等于交进来的总数，不许有文件凭空蒸发
    expect(plan.accepted.length + plan.skippedSameSource + plan.skippedSameContent).toBe(3)
  })

  it('读不到的文件放行而不是冒充成「重复」', async () => {
    const gone = path.join(P.files, '已经不存在.md')
    const plan = await planFileIngest('kbA', [gone])
    expect(plan.accepted).toEqual([gone])
    expect(plan.skippedSameContent).toBe(0)
  })

  it('换个知识库就不算重复（拦的是「同一个库里重复」，不是全局唯一）', async () => {
    const f = writeFile('c1.md', '戊内容')
    seedDoc('kbA', f, await hashFile(f))
    const plan = await planFileIngest('kbB', [f])
    expect(plan.accepted).toEqual([f])
  })

  it('反向对照：旧数据没有 content_hash 时不参与匹配，新文件照样收', async () => {
    const f = writeFile('d1.md', '己内容')
    seedDoc('kbA', f, null)
    const same = writeFile('d2.md', '己内容')
    const plan = await planFileIngest('kbA', [same])
    expect(plan.accepted).toEqual([same])
    expect(plan.skippedSameContent).toBe(0)
  })
})

describe('kbDocRepo.findBySource（URL 重复添加靠它回给前端）', () => {
  it('命中返回库里那篇，未命中返回 null；同来源多行时取最早的一篇', () => {
    const url = 'https://example.com/a'
    expect(kbDocRepo.findBySource('kbA', url)).toBeNull()
    const first = seedDoc('kbA', url, null)
    expect(kbDocRepo.findBySource('kbA', url)?.id).toBe(first)
    // 脏数据（历史上没拦时留下的两行）也稳定回最早那篇，而不是随机一条
    const second = seedDoc('kbA', url, null)
    expect(kbDocRepo.findBySource('kbA', url)?.id).toBe(first)
    expect(second).not.toBe(first)
    // 别的库不算命中
    expect(kbDocRepo.findBySource('kbB', url)).toBeNull()
  })
})

describe('添加入口真的走了这道闸（IPC 接线，不是只测纯函数）', () => {
  interface AddResult {
    docs: KbDocument[]
    skippedSameSource: number
    skippedSameContent: number
  }

  const addFiles = async (kbId: string): Promise<AddResult> =>
    (await H.handlers.get(IPC.KB_DOC_ADD_FILE)!({}, kbId)) as AddResult
  const addFolder = async (kbId: string): Promise<AddResult> =>
    (await H.handlers.get(IPC.KB_DOC_ADD_FOLDER)!({}, kbId)) as AddResult

  it('同一个文件选两次：第二次既不建文档也不排队（embedding 不重复花）', async () => {
    const f = writeFile('e1.md', '庚内容')
    H.enqueued.length = 0
    H.dialogPaths = [f]

    const first = await addFiles('kbA')
    expect(first.docs).toHaveLength(1)
    expect(H.enqueued).toHaveLength(1)

    const again = await addFiles('kbA')
    expect(again.docs).toHaveLength(0)
    expect(again.skippedSameSource).toBe(1)
    // 这条才是本批的落点：没有第二次排队 ⇒ 没有第二遍解析与向量化
    expect(H.enqueued).toHaveLength(1)
    expect(kbDocRepo.list('kbA').filter((d) => d.source === f)).toHaveLength(1)
  })

  it('再导一遍同一个目录：一份新文档都不建，跳过计数如实回给前端', async () => {
    const dir = path.join(P.files, 'batch')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'x.md'), 'X 内容', 'utf8')
    fs.writeFileSync(path.join(dir, 'y.md'), 'Y 内容', 'utf8')
    H.enqueued.length = 0
    H.dialogPaths = [dir]

    const first = await addFolder('kbB')
    expect(first.docs).toHaveLength(2)
    expect(H.enqueued).toHaveLength(2)

    const again = await addFolder('kbB')
    expect(again.docs).toHaveLength(0)
    expect(again.skippedSameSource).toBe(2)
    expect(H.enqueued).toHaveLength(2)
  })

  it('同一网址第二次不建第二份，并把 duplicated 如实回给前端', async () => {
    H.enqueued.length = 0
    const url = 'https://example.com/repeat'
    const r1 = (await H.handlers.get(IPC.KB_DOC_ADD_URL)!({}, 'kbA', url)) as {
      doc: KbDocument | null
      duplicated: boolean
    }
    expect(r1.duplicated).toBe(false)
    expect(H.enqueued).toHaveLength(1)

    const r2 = (await H.handlers.get(IPC.KB_DOC_ADD_URL)!({}, 'kbA', url)) as {
      doc: KbDocument | null
      duplicated: boolean
    }
    expect(r2.duplicated).toBe(true)
    expect(r2.doc?.id).toBe(r1.doc?.id)
    expect(H.enqueued).toHaveLength(1)
  })
})
