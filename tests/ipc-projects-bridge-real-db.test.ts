// 多文件项目 IPC 真桥往返：preload api → 注册的 handler → service/DB/磁盘
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-project-ipc'
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
import { registerProjectHandlers } from '../src/main/ipc/handlers/projects'
import { PROJECTS_DIR, createProject } from '../src/main/projects/project-service'
import '../src/preload/index'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

let projectId = ''
let dirAbs = ''

describe('多文件项目 IPC 桥', () => {
  beforeAll(() => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(P.dir, { recursive: true })
    dbService.open()
    dbService.runMigrations()
    registerProjectHandlers()
    const created = createProject({
      name: '桥测项目',
      files: [
        { path: 'index.html', content: '<html><body>bridge</body></html>' },
        { path: 'README.md', content: '# bridge' }
      ]
    })
    if (!created.ok) throw new Error(created.message)
    projectId = created.project.id
    dirAbs = path.join(PROJECTS_DIR, created.project.dirName)
  })

  afterAll(() => {
    try {
      dbService.close()
    } catch {
      /* ignore */
    }
    fs.rmSync(P.dir, { recursive: true, force: true })
  })

  it('previewProject：清单 + index.html + README.md', async () => {
    const p = await call('previewProject', projectId)
    expect(p.dirName).toBe('桥测项目')
    expect(p.relPath).toBe('generated/projects/桥测项目')
    expect(p.files.map((f: { path: string }) => f.path)).toEqual(['README.md', 'index.html'])
    expect(p.indexHtml).toContain('bridge')
    expect(p.readme).toContain('# bridge')
  })

  it('exportProjectZip：返回 generated/projects/xxx.zip 且文件在磁盘上', async () => {
    const res = await call('exportProjectZip', projectId)
    expect(res.ok).toBe(true)
    expect(res.relPath).toBe('generated/projects/桥测项目.zip')
    expect(fs.existsSync(path.join(PROJECTS_DIR, res.fileName))).toBe(true)
    expect(res.bytes).toBeGreaterThan(0)
  })

  it('deleteProject：改过文件 → SNAPSHOT_DIVERGED；还原后撤销成功', async () => {
    fs.writeFileSync(path.join(dirAbs, 'README.md'), '# changed', 'utf8')
    const refused = await call('deleteProject', projectId)
    expect(refused.ok).toBe(false)
    expect(refused.code).toBe('SNAPSHOT_DIVERGED')
    expect(refused.path).toBe('README.md')

    fs.writeFileSync(path.join(dirAbs, 'README.md'), '# bridge', 'utf8')
    const ok = await call('deleteProject', projectId)
    expect(ok.ok).toBe(true)
    expect(fs.existsSync(dirAbs)).toBe(false)
  })
})
