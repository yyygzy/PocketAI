// 真 IPC 往返：preload 的 api 直接接到主进程注册进来的 handler 上（V4-Iter-139）
//
// 为什么必须有这一层：我此前所有用例都是"从组件里调桩"或"从主进程里调 handler"，
// 中间的**桥**没人走 —— 通道常量写错、位置参数顺序错、返回值形状改了渲染层没跟上，
// 两类测试都不会红。这一份把 preload 的 `window.pocketai` 抓出来，
// 让它的每一次 invoke 落到真 handler 上（真临时库、真 dialog 脚本、真 SEC-6 令牌）。
//
// 顺带钉住 `safeHandle` 的合同：**失败是返回值 `{ok:false,error}`，不是 reject**。
// 这条合同渲染层不兑现，就会出现"删除失败却报全成功"——本轮同时修掉（见台账 V4-Iter-139）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-ipc-bridge'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext', files: dir + sep + 'files' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown,
  /** dialog 交回的路径（文件/目录/评测集共用这一个脚本） */
  dialogPaths: [] as string[],
  enqueued: [] as string[]
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

// 入库/队列替身：本文件测的是"桥"，不是排队之后发生什么
vi.mock('../src/main/knowledge/index-queue', () => ({
  indexQueue: {
    enqueue: (t: { docId: string }) => {
      H.enqueued.push(t.docId)
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

vi.mock('../src/main/knowledge/embedding', () => ({
  embedQuery: async () => new Float32Array([1, 0, 0]),
  embedTexts: async () => []
}))

// 一个 mock 同时假扮两侧：ipcMain 收集 handler，ipcRenderer 把 invoke 直接投递过去
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.dir, getAppPath: () => P.dir, quit: () => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {},
    removeHorizontalListener: () => {}
  },
  ipcRenderer: {
    invoke: async (ch: string, ...args: unknown[]) => {
      const fn = H.handlers.get(ch)
      if (!fn) throw new Error(`渲染层指向了一个没人注册的通道：${ch}`)
      return fn({}, ...args)
    },
    on: () => () => {},
    removeListener: () => {},
    send: () => {}
  },
  contextBridge: {
    exposeInMainWorld: (_name: string, api: unknown) => {
      H.api = api
    }
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
  nativeImage: { createFromPath: () => ({}) }
}))

import { dbService } from '../src/main/db/database'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'
import { registerKnowledgeHandlers } from '../src/main/ipc/handlers/knowledge'
import { registerStewardHandlers } from '../src/main/ipc/handlers/steward'
import '../src/preload/index'
import { stringifyKbEvalSet } from '../src/shared/kb-eval'

// preload 暴露的每个方法都按名字取：没有这个方法就当场报错（不静默 undefined）
const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}
const has = (name: string): unknown => (H.api as Record<string, unknown>)[name]

const DOC_V = new Float32Array([1, 0, 0])

function writeFile(name: string, content: string): string {
  const p = path.join(P.files, name)
  fs.writeFileSync(p, content, 'utf8')
  return p
}

let DOC_X = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.files, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerKnowledgeHandlers()
  // 批量重建那条通道住在 steward 里，桥层要能走通就得一并注册
  try {
    registerStewardHandlers()
  } catch {
    /* steward 还注册了别的模块，缺依赖时忽略：本文件只用到 KB 相关通道 */
  }

  kbRepo.save({
    id: 'kbB',
    name: '桥测库',
    embeddingProviderId: 'p1',
    embeddingModel: 'm1',
    chunkSize: 800,
    chunkOverlap: 200,
    topK: 5,
    topN: 3,
    minScore: 0
  })
  const doc = kbDocRepo.insert({ kbId: 'kbB', source: writeFile('桥测文档.md', '退款额说明'), sourceType: 'md', title: '桥测文档' })
  DOC_X = doc.id
  kbChunkRepo.insertMany([
    { id: 'c-bridge-0', docId: doc.id, kbId: 'kbB', sequence: 0, content: '退款额说明', embedding: DOC_V }
  ])
  kbDocRepo.setContentHash(doc.id, 'stale-hash-on-purpose')
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('preload ⇄ 主进程：通道与参数真的对得上', () => {
  it('preload 把 api 挂上了 window.pocketai，且本轮涉及的通道全都在主进程注册过', () => {
    expect(typeof H.api).toBe('object')
    for (const fn of ['listKbDocuments', 'addKbFiles', 'addKbFolder', 'addKbUrl', 'pickKbEvalSet', 'runKbEval',
      'reindexKbDocs', 'setKbDocEnabled', 'checkKbUpdates', 'saveKnowledgeBase']) {
      expect(typeof has(fn)).toBe('function')
    }
  })

  it('listKbDocuments / setKbDocEnabled 往返：改完再列表，enabled 真的变了', async () => {
    const before = await call('listKbDocuments','kbB')
    expect(before[0]!.enabled).toBe(true)
    await call('setKbDocEnabled','kbB', DOC_X, false)
    const after = await call('listKbDocuments','kbB')
    expect(after[0]!.enabled).toBe(false)
    await call('setKbDocEnabled','kbB', DOC_X, true)
  })

  it('saveKnowledgeBase 带 minScore ⇒ 落到真库、再读回来还是它（migration v47 的往返）', async () => {
    const saved = await call('saveKnowledgeBase',{ id: 'kbB', name: '桥测库', minScore: 0.42 })
    expect(saved.ok === false).toBe(false)
    const list = await call('listKnowledgeBases')
    expect(list.find((k: { id: string }) => k.id === 'kbB').minScore).toBe(0.42)
    await call('saveKnowledgeBase',{ id: 'kbB', name: '桥测库', minScore: 0 })
  })

  it('同一文件经桥层加两次：第二次零新建、跳过计数如实回给渲染层', async () => {
    const f = writeFile('重复我.md', '同一个内容')
    H.dialogPaths = [f]
    const first = await call('addKbFiles','kbB')
    expect(first.docs).toHaveLength(1)
    const again = await call('addKbFiles','kbB')
    expect(again).toMatchObject({ docs: [], skippedSameSource: 1, skippedSameContent: 0 })
  })

  it('同一网址第二次：duplicated=true 且回的是库里那篇（不再抓第二遍）', async () => {
    const url = 'https://example.com/bridge'
    const first = await call('addKbUrl','kbB', url)
    expect(first.duplicated).toBe(false)
    const again = await call('addKbUrl','kbB', url)
    expect(again.duplicated).toBe(true)
    expect(again.doc.id).toBe(first.doc.id)
  })

  it('SEC-6 令牌往返：pick issued 的令牌真能换回文件并算出指标；伪造令牌是**结构化失败**', async () => {
    const setFile = path.join(P.files, '卷子.json')
    fs.writeFileSync(
      setFile,
      stringifyKbEvalSet({
        version: 1,
        kbId: 'kbB',
        name: '桥测卷',
        cases: [{ id: 'q1', query: '退款额', expected: [{ docId: DOC_X }] }]
      }),
      'utf8'
    )
    H.dialogPaths = [setFile]
    const picked = await call('pickKbEvalSet')
    expect(picked.fileName).toBe('卷子.json')

    const r = await call('runKbEval','kbB', picked.token)
    expect(r.metrics.cases).toBe(1)
    expect(r.rows[0].firstRank).toBe(1)

    // 令牌过期/伪造 ⇒ safeHandle 转成 {ok:false,error}，不是抛异常
    const bad = await call('runKbEval','kbB', 'not-a-real-token')
    expect(bad.ok).toBe(false)
    expect(String(bad.error)).toMatch(/已过期/)
  })

  it('checkKbUpdates 经桥层给出真判定（源文件已变 ⇒ changed）', async () => {
    const r = await call('checkKbUpdates','kbB')
    expect(r.checked).toBeGreaterThanOrEqual(1)
    expect(r.issues.some((i: { kind: string }) => i.kind === 'changed')).toBe(true)
  })

  it('成功也是值：停用与删除通道返回 {ok:true}——这正是 isIpcFail 那个 ok-in-v 判约会误读的形状', async () => {
    const doc = kbDocRepo.insert({ kbId: 'kbB', source: '一次性.md', sourceType: 'txt', title: '一次性' })
    expect(await call('setKbDocEnabled', 'kbB', doc.id, false)).toEqual({ ok: true })
    expect((await call('listKbDocuments', 'kbB')).find((d: { id: string }) => d.id === doc.id).enabled).toBe(false)
    expect(await call('deleteKbDocument', doc.id)).toEqual({ ok: true })
    expect((await call('listKbDocuments', 'kbB')).some((d: { id: string }) => d.id === doc.id)).toBe(false)
  })

  it('批量重建通道：不存在的 id 会被跳过，enqueued 是真实数（渲染层据此报差值）', async () => {
    const r = await call('reindexKbDocs',[DOC_X, '没有这个文档'])
    expect(r).toEqual({ enqueued: 1 })
  })
})
