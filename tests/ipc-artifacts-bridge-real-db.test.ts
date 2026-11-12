// 产物 IPC 真桥往返：preload api → 注册的 handler → service/DB/磁盘
//
// 钉住三件事：
//  · 通道常量/参数顺序/返回形状在桥这一层真的对得上（组件测试和 handler 测试都覆盖不到）；
//  · ArtifactMeta.relPath 必须是 `generated/xxx`，否则另存为/打开所在目录会指错；
//  · safeHandle 的失败合同是 `{ok:false,error}`，不是 reject（形状闸门依赖这条）。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-artifact-ipc'
  return { dir, db: dir + sep + 'app.db' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown
}))

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.dir, getAppPath: () => P.dir, quit: () => {} },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => {
      H.handlers.set(ch, fn)
    },
    on: () => {},
    removeListener: () => {}
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
  dialog: { showSaveDialog: async () => ({ canceled: true, filePath: '' }), showErrorBox: () => {} },
  shell: { openPath: async () => '', showItemInFolder: () => {} },
  BrowserWindow: class {
    static getAllWindows() {
      return []
    }
  }
}))

import { dbService } from '../src/main/db/database'
import { registerArtifactHandlers } from '../src/main/ipc/handlers/artifacts'
import { buildPptx } from '../src/main/artifacts/generators/pptx'
import { buildDocx } from '../src/main/artifacts/generators/docx'
import { ARTIFACTS_DIR, saveArtifact } from '../src/main/artifacts/artifact-service'
import '../src/preload/index'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

let pptxId = ''
let mdId = ''
let docxId = ''

beforeAll(async () => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerArtifactHandlers()

  const bytes = await buildPptx({
    title: '桥测演示',
    slides: [{ title: '第一页', bullets: ['要点一'] }, { title: '第二页' }]
  })
  pptxId = saveArtifact({ kind: 'pptx', title: '桥测演示', bytes, conversationId: 'conv-b' }).id
  mdId = saveArtifact({ kind: 'md', title: '桥测文档', bytes: Buffer.from('# 标题\n正文') }).id
  const docxBytes = await buildDocx({
    title: '桥测 Word',
    sections: [{ heading: '一、背景', paragraphs: ['正文段落'], bullets: ['要点'] }]
  })
  docxId = saveArtifact({ kind: 'docx', title: '桥测 Word', bytes: docxBytes }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('artifact IPC 桥', () => {
  it('listArtifacts：返回元数据且 relPath 指向 generated/', async () => {
    const list = await call('listArtifacts', 'conv-b')
    expect(list).toHaveLength(1)
    expect(list[0].id).toBe(pptxId)
    expect(list[0].relPath).toBe(`generated/${list[0].fileName}`)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, list[0].fileName))).toBe(true)
  })

  it('previewArtifact：pptx 给文字大纲，md 给正文', async () => {
    const pptx = await call('previewArtifact', pptxId)
    expect(pptx.kind).toBe('pptx')
    expect(pptx.missing).toBe(false)
    // 大纲按文件里的真实页序给：第 1 页是封面（标题＝演示标题），内容页从第 2 页起
    expect(pptx.slides).toHaveLength(3)
    expect(pptx.slides[0].title).toBe('桥测演示')
    expect(pptx.slides[1].title).toBe('第一页')
    expect(pptx.slides[1].lines).toContain('要点一')

    const md = await call('previewArtifact', mdId)
    expect(md.kind).toBe('md')
    expect(md.markdown).toBe('# 标题\n正文')
  })

  it('previewArtifact：docx 给 mammoth HTML（无脚本），供 sandbox iframe 渲染', async () => {
    const docx = await call('previewArtifact', docxId)
    expect(docx.kind).toBe('docx')
    expect(docx.missing).toBe(false)
    expect(docx.html).toContain('正文段落')
    expect(docx.html).toContain('<p>')
    expect(docx.html).toContain('<li>')
    expect(docx.html.toLowerCase()).not.toContain('<script')
  })

  it('previewArtifact：不存在的 id → null；非法参数 → {ok:false}', async () => {
    expect(await call('previewArtifact', '00000000-0000-0000-0000-000000000000')).toBeNull()
    const bad = await call('previewArtifact', 'short')
    expect(bad).toMatchObject({ ok: false })
  })

  it('deleteArtifact：返回 {ok:true} 并清掉磁盘文件；重复删除 false', async () => {
    const before = await call('listArtifacts', null)
    const target = before.find((a: { id: string }) => a.id === mdId)
    expect(target).toBeTruthy()
    expect(await call('deleteArtifact', mdId)).toEqual({ ok: true })
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, target.fileName))).toBe(false)
    expect(await call('deleteArtifact', mdId)).toEqual({ ok: false })
  })
})
