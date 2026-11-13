// 工作目录项目两条通道的真桥往返（方案 A）：
//   project:open-dir      绝对路径 → 主进程重新 realpath 校验 → shell.openPath
//   project:export-zip-abs 绝对路径 → 校验 → 保存框 → archiver 打包 → .pocketai-tmp + rename
// 这里走的是 preload api → 注册的 handler → project-target/project-service，不用手搓 handler 入参。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-project-ipc-483'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data', ws: dir + sep + 'workspace' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown,
  openPathCalls: [] as string[],
  /** 非空时 shell.openPath 以"系统拒绝"返回这句（真实 API 用返回值报错，不抛） */
  openPathFailure: '',
  saveDialog: { canceled: true, filePath: '' } as { canceled: boolean; filePath: string },
  saveDialogCalls: [] as Array<{ win: unknown; opts: Record<string, unknown> }>,
  fakeWindow: { id: 483 }
}))

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db }))
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
      return fn({ sender: {} }, ...args)
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
    showSaveDialog: async (win: unknown, opts: Record<string, unknown>) => {
      H.saveDialogCalls.push({ win, opts })
      return H.saveDialog
    },
    showErrorBox: () => {}
  },
  shell: {
    openPath: async (p: string) => {
      H.openPathCalls.push(p)
      return H.openPathFailure
    },
    showItemInFolder: () => {}
  },
  BrowserWindow: class {
    static fromWebContents(): unknown {
      return H.fakeWindow
    }
    static getAllWindows() {
      return []
    }
  }
}))

import { dbService } from '../src/main/db/database'
import { setWorkspaceDir } from '../src/main/tools/fs-tools'
import { registerProjectHandlers } from '../src/main/ipc/handlers/projects'
import '../src/preload/index'

const WS = P.ws
const APPS = path.join(WS, 'apps')

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

const errOf = (res: { error?: string }): string => String(res.error ?? '')

function tmpLeftovers(dir: string, base: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.startsWith(`${base}.pocketai-tmp`))
}

describe('工作目录项目 IPC（方案 A）', () => {
  beforeAll(() => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(WS, { recursive: true })
    fs.mkdirSync(P.data, { recursive: true })
    dbService.open()
    dbService.runMigrations()
    registerProjectHandlers()
  })

  afterAll(() => {
    try {
      dbService.close()
    } catch {
      /* ignore */
    }
    fs.rmSync(P.dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    setWorkspaceDir(WS)
    H.openPathCalls = []
    H.openPathFailure = ''
    H.saveDialog = { canceled: true, filePath: '' }
    H.saveDialogCalls = []
    fs.rmSync(APPS, { recursive: true, force: true })
    fs.mkdirSync(path.join(APPS, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(APPS, 'demo', 'index.html'), '<html><body>hi</body></html>', 'utf8')
  })

  // ---------- 打开所在目录 ----------

  it('open-dir：工作目录内的绝对路径 → 调 shell.openPath 且原样回报路径', async () => {
    const dirAbs = path.join(APPS, 'demo')
    const res = await call('openProjectDir', dirAbs)
    expect(res.ok).toBe(true)
    expect(res.path).toBe(dirAbs)
    expect(H.openPathCalls).toEqual([dirAbs])
  })

  it('open-dir：工作目录外 / 前缀相似的兄弟目录 / 相对路径 / .. 穿越 一律拒，且不碰 shell', async () => {
    const outside = path.join(P.dir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    // 与工作目录同前缀的兄弟目录：`startsWith(ws)` 若少了分隔符就会被放行
    const sibling = `${WS}-evil`
    fs.mkdirSync(sibling, { recursive: true })

    for (const bad of [
      outside,
      sibling,
      'apps/demo',
      path.join(WS, '..', 'outside'),
      './apps/demo'
    ]) {
      const res = await call('openProjectDir', bad)
      expect(res.ok, `应拒绝：${bad}`).toBe(false)
      expect(errOf(res).startsWith('PROJECT_OPEN_DIR_DENIED:'), bad).toBe(true)
    }
    expect(H.openPathCalls).toEqual([])
  })

  it('open-dir：含 NUL / 不是目录 / 目录已消失 都有可读失败面', async () => {
    const nul = `${path.join(APPS, 'demo')}\0x`
    const r1 = await call('openProjectDir', nul)
    expect(r1.ok).toBe(false)
    expect(errOf(r1).startsWith('PROJECT_OPEN_DIR_DENIED:')).toBe(true)

    const file = path.join(APPS, 'demo', 'index.html')
    const r2 = await call('openProjectDir', file)
    expect(r2.ok).toBe(false)
    expect(errOf(r2)).toContain('不是目录')

    const ghost = path.join(APPS, 'ghost')
    const r3 = await call('openProjectDir', ghost)
    expect(r3.ok).toBe(false)
    expect(errOf(r3).startsWith('PROJECT_DIR_MISSING:')).toBe(true)

    expect(H.openPathCalls).toEqual([])
  })

  it('open-dir：符号链接指向工作目录外 → 拒（无权限建链接则跳过）', async () => {
    const outside = path.join(P.dir, 'link-target')
    fs.mkdirSync(outside, { recursive: true })
    const link = path.join(WS, 'escape-link')
    try {
      fs.symlinkSync(outside, link, 'dir')
    } catch {
      return // Windows 未开开发者模式/无权限：CI 上由 realpath 分支覆盖
    }
    const res = await call('openProjectDir', link)
    expect(res.ok).toBe(false)
    expect(errOf(res)).toContain('符号链接')
    expect(H.openPathCalls).toEqual([])
  })

  it('open-dir：shell.openPath 以返回值报"系统拒绝" → 可读失败，不谎报成功', async () => {
    H.openPathFailure = '拒绝访问'
    const res = await call('openProjectDir', path.join(APPS, 'demo'))
    expect(res.ok).toBe(false)
    expect(errOf(res).startsWith('PROJECT_OPEN_DIR_DENIED:')).toBe(true)
    expect(errOf(res)).toContain('拒绝访问')
  })

  it('open-dir：未设置工作目录 → PROJECT_TARGET_NO_WORKSPACE（不是静默失败）', async () => {
    setWorkspaceDir('')
    const res = await call('openProjectDir', path.join(APPS, 'demo'))
    expect(res.ok).toBe(false)
    expect(errOf(res).startsWith('PROJECT_TARGET_NO_WORKSPACE:')).toBe(true)
  })

  // ---------- 导出 ZIP ----------

  it('export-zip-abs：保存框 → 打包到所选路径，取消才算取消、残渣为零', async () => {
    const dest = path.join(P.dir, 'demo-export.zip')
    H.saveDialog = { canceled: false, filePath: dest }

    const res = await call('exportProjectZipAbs', path.join(APPS, 'demo'))
    expect(res.ok).toBe(true)
    expect(res.canceled).toBeUndefined()
    expect(res.path).toBe(dest)
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.statSync(dest).size).toBeGreaterThan(0)
    // archiver 产出的确实是 zip（本地文件头 PK\x03\x04），且打进去的是目录内容
    const buf = fs.readFileSync(dest)
    expect(buf.subarray(0, 2).toString('latin1')).toBe('PK')
    expect(buf.includes(Buffer.from('index.html'))).toBe(true)
    expect(tmpLeftovers(P.dir, 'demo-export')).toEqual([])

    expect(H.saveDialogCalls).toHaveLength(1)
    expect(H.saveDialogCalls[0]!.win).toBe(H.fakeWindow)
    expect(H.saveDialogCalls[0]!.opts.defaultPath).toBe('demo.zip')
    expect(H.saveDialogCalls[0]!.opts.filters).toBeTruthy()
  })

  it('export-zip-abs：取消是静默成功（ok+canceled），不写文件、不报错', async () => {
    const dest = path.join(P.dir, 'canceled.zip')
    H.saveDialog = { canceled: true, filePath: '' }

    const res = await call('exportProjectZipAbs', path.join(APPS, 'demo'))
    expect(res.ok).toBe(true)
    expect(res.canceled).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    expect(tmpLeftovers(P.dir, 'demo-export')).toEqual([])
  })

  it('export-zip-abs：打包失败可读且不留半份 zip / 临时文件', async () => {
    // 目标父目录不存在 ⇒ createWriteStream 打开失败 ⇒ zipDirToFile 必须回滚
    const dest = path.join(P.dir, 'no-such-dir', 'demo.zip')
    H.saveDialog = { canceled: false, filePath: dest }

    const res = await call('exportProjectZipAbs', path.join(APPS, 'demo'))
    expect(res.ok).toBe(false)
    expect(errOf(res).startsWith('PROJECT_EXPORT_FAILED:')).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(`${dest}.pocketai-tmp`)).toBe(false)
    expect(fs.existsSync(path.join(P.dir, 'no-such-dir'))).toBe(false)
  })

  it('export-zip-abs：rename 失败也清掉半成品，目标位置不留 zip', async () => {
    const dest = path.join(P.dir, 'rename-fail.zip')
    H.saveDialog = { canceled: false, filePath: dest }
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted')
    })
    try {
      const res = await call('exportProjectZipAbs', path.join(APPS, 'demo'))
      expect(res.ok).toBe(false)
      expect(errOf(res).startsWith('PROJECT_EXPORT_FAILED:')).toBe(true)
    } finally {
      spy.mockRestore()
    }
    expect(fs.existsSync(dest)).toBe(false)
    expect(fs.existsSync(`${dest}.pocketai-tmp`)).toBe(false)
  })

  it('export-zip-abs：越界路径在校验处就拒，根本不弹保存框', async () => {
    const outside = path.join(P.dir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    const res = await call('exportProjectZipAbs', outside)
    expect(res.ok).toBe(false)
    expect(errOf(res).startsWith('PROJECT_OPEN_DIR_DENIED:')).toBe(true)
    expect(H.saveDialogCalls).toEqual([])
  })
})
