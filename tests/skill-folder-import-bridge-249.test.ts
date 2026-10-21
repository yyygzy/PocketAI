// 「导入技能目录」的桥层自证（V4-Iter-249）——真 preload 方法 → 真通道名 → 真 handler → dialog 桩 → 真库落行 → 真资源快照落盘。
//
// 为什么要再补这一份（§236 那 18 例已经是真 fs 了）：那 18 例测的是 `readSkillFolder`／`installSkillFiles` 这些**函数**，
// 而界面那颗键走的其实是另一条路——preload 的 `importSkillFolder()` → `IPC.SKILL_IMPORT_FOLDER` → handler 里
// `BrowserWindow.fromWebContents(e.sender)` 取窗口 → 弹对话框 → 才轮到那两个函数。**通道名写错、handler 没注册、
// 或窗口取不到直接 return「窗口不可用」，那 18 例一条都不会红**（§139/§142 那一族的第三种形态）。
// 本批撞它撞得很具体：真机连点三次「导入技能目录」＋用户三次操作原生对话框，库里一条技能都没多出来，
// 而这份用例一次就通 ⇒ 把"链是好的、差的只是那一次选择"这条判断从猜测变成证据。
// dialog 是这里唯一必须桩掉的东西（原生对话框没法在 CI 里点）；桩只负责"交回一个路径"，剩下全是真的。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-b134-probe'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

const SEL = vi.hoisted(() => ({ paths: [] as string[], canceled: false }))
const H = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(), api: null as unknown }))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  EXTENSIONS_DIR: P.ext,
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
    on: () => {},
    removeListener: () => {}
  },
  ipcRenderer: {
    invoke: async (ch: string, ...args: unknown[]) => {
      const fn = H.handlers.get(ch)
      if (!fn) throw new Error(`没有注册这根通道：${ch}`)
      return fn({}, ...args)
    },
    on: () => () => {},
    removeListener: () => {},
    send: () => {}
  },
  contextBridge: { exposeInMainWorld: (_n: string, api: unknown) => { H.api = api } },
  dialog: {
    showOpenDialog: async () => ({ canceled: SEL.canceled, filePaths: SEL.paths }),
    showSaveDialog: async () => ({ canceled: true, filePath: '' }),
    showErrorBox: () => {}
  },
  BrowserWindow: class {
    static fromWebContents() {
      return {}
    }
    static getAllWindows() {
      return [{}]
    }
  },
  nativeImage: { createFromPath: () => ({}) }
}))

import { dbService } from '../src/main/db/database'
import { registerSkillHandlers } from '../src/main/ipc/handlers/skills'
import '../src/preload/index'
import { IPC } from '../src/shared/types'

const SKILL_DIR = path.resolve(__dirname, '../data/tmp/skill-import-b134')

const call = async (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<unknown>)(...args)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerSkillHandlers()
})

afterAll(() => {
  dbService.close()
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('SKILL_IMPORT_FOLDER 整条桥（真 preload ⇄ 真 handler ⇄ 真库 ⇄ 真盘，只桩对话框）', () => {
  it('通道注册了、preload 也暴露了方法名（这两条先排除"根本没接线"）', () => {
    expect(H.handlers.has(IPC.SKILL_IMPORT_FOLDER), `主进程没注册 ${IPC.SKILL_IMPORT_FOLDER}`).toBe(true)
    expect(typeof (H.api as Record<string, unknown>).importSkillFolder).toBe('function')
  })

  it('交回我们那个真目录 ⇒ 返回值与落盘两侧都要成立', async () => {
    SEL.canceled = false
    SEL.paths = [SKILL_DIR]
    const r = await call('importSkillFolder')
    console.log('返回 =', JSON.stringify(r).slice(0, 500))
    expect(r.ok, `导入被拒：${r.error}`).toBe(true)
    const id = r.skill.id as string
    const dir = path.join(P.dir, 'skills', id)
    const onDisk = (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String) : [])
      .map((p) => p.split(path.sep).join('/'))
    console.log('落盘 =', onDisk.join(', '))
    expect(onDisk.sort()).toEqual(['references', 'references/notes.md', 'scripts', 'scripts/count.sh'].sort())
    const list = await call('listSkillFiles', id)
    console.log('清单 =', JSON.stringify(list))
    expect(list.files.map((f: { path: string }) => f.path).sort()).toEqual(['references/notes.md', 'scripts/count.sh'])
    // 删技能连自带文件一起走（这条也是桥：SKILL_DELETE 里那次 removeSkillFiles 只有跨桥才证得到）
    const del = await call('deleteSkill', id)
    expect(del).toEqual({ ok: true, filesRemoved: true })
    expect(fs.existsSync(dir)).toBe(false)
  })

  it('反向对照：对话框取消 ⇒ {ok:true,canceled:true} 且不落库不落盘', async () => {
    const before = await call('listSkills')
    SEL.canceled = true
    SEL.paths = []
    const r = await call('importSkillFolder')
    expect(r).toEqual({ ok: true, canceled: true })
    const after = await call('listSkills')
    expect(after.length).toBe(before.length)
  })
})
