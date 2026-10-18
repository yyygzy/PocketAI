// dataHealth:clear-cache 这一跳的真桥层自证（V4-Iter-189）
//
// 为什么值得单独一份：这颗按钮的成败判定与"前后两个数"都跨进程，
// 组件用例打的是桩（只会知道"发没发通道"），主进程用例又绕开桥——
// 139 那批就是因为这个缺口把"失败当成功"漏了三次。所以这里真跨一次：
// 真 preload 暴露的 api + 真注册的 handler + 真 cache-clean 模块，只把 Chromium 的 clearCache 与档案树统计换成桩。
import { describe, it, expect, vi } from 'vitest'

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown,
  clearCacheCalls: 0,
  clearCacheError: null as string | null,
  statsArgs: [] as boolean[]
}))

vi.mock('../src/main/steward/data-health', () => ({
  getDataHealthReport: () => ({ sizes: {} }),
  // 只替这一层：档案树"有多大"不重要，重要的是清理前后各以 refresh=true 现数一次（那才是 memo 失效的证据）
  getBrowserCacheStats: (refresh: boolean) => {
    H.statsArgs.push(refresh === true)
    return { bytes: 584_000_000, files: 7486 }
  },
  browserCacheTreeBreakdown: () => [
    { tree: 'userdata', bytes: 334_700_000, files: 4468 },
    { tree: 'session', bytes: 249_300_000, files: 3018 }
  ]
}))
vi.mock('../src/main/portable', () => ({ DATA_DIR: '/tmp/x', DB_PATH: '/tmp/x/app.db', LOGS_DIR: '/tmp/x/logs' }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp/x', getAppPath: () => '/tmp/x', quit: () => {} },
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
      if (!fn) throw new Error('渲染层指向了一个没人注册的通道：' + ch)
      return fn({}, ...args)
    },
    on: () => () => {},
    removeListener: () => {},
    send: () => {}
  },
  contextBridge: { exposeInMainWorld: (_n: string, api: unknown) => { H.api = api } },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true, filePath: '' }) },
  shell: { openPath: async () => '' },
  session: {
    defaultSession: {
      clearCache: async () => {
        H.clearCacheCalls++
        if (H.clearCacheError) throw new Error(H.clearCacheError)
      }
    }
  },
  BrowserWindow: class {
    static fromWebContents() { return undefined }
    static getAllWindows() { return [] }
  },
  nativeImage: { createFromPath: () => ({}) }
}))

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { registerStewardHandlers } from '../src/main/ipc/handlers/steward'
import '../src/preload/index'

type ClearResult = { ok: boolean; beforeBytes: number; afterBytes: number; error?: string }

function clearBrowserCache(): Promise<ClearResult> {
  const fn = (H.api as Record<string, unknown>).clearBrowserCache
  if (typeof fn !== 'function') throw new Error('preload 没暴露 clearBrowserCache')
  return (fn as () => Promise<ClearResult>)()
}

describe('dataHealth:clear-cache 的成败形状', () => {
  it('Chromium 清成功 ⇒ {ok:true} + 前后两个数，且档案树统计被以 refresh 现数两次（memo 因此不会留着旧数）', async () => {
    registerStewardHandlers()
    H.clearCacheCalls = 0
    H.clearCacheError = null
    H.statsArgs = []
    const r = await clearBrowserCache()
    expect(r).toEqual({ ok: true, beforeBytes: 584_000_000, afterBytes: 584_000_000 })
    expect(H.clearCacheCalls).toBe(1)
    expect(H.statsArgs, '清理前后各要现数一次，否则界面上的"缓存"还是清理前的数').toEqual([true, true])
  })

  it('Chromium 抛错 ⇒ {ok:false} 且把原因带回去（不许把没做成的清理画成释放了空间）', async () => {
    registerStewardHandlers()
    H.statsArgs = []
    H.clearCacheError = '磁盘正被占用'
    const r = await clearBrowserCache()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('磁盘正被占用')
    expect(H.statsArgs).toEqual([true, true])
    H.clearCacheError = null
  })
})

// 台账 V4-Iter-182 定的三条硬约束里，有两条只能靠"源码里不许出现某个东西"来守：
// 走文件系统删除＝在 Chromium 持有这些文件时给自己留半态；通道收路径＝多一处校验面。
describe('清理的两条设计约束不许被"顺手改宽"（scan）', () => {
  const CLEAN = readFileSync(path.join(process.cwd(), 'src/main/steward/cache-clean.ts'), 'utf8')
  const HANDLER = readFileSync(path.join(process.cwd(), 'src/main/ipc/handlers/steward.ts'), 'utf8')

  it('cache-clean 只做 session.clearCache()，不许出现文件系统删除', () => {
    expect(CLEAN).toContain('session.defaultSession.clearCache()')
    for (const banned of ['rmSync', 'rm(', 'rimraf', 'unlinkSync', 'node:fs']) {
      expect(CLEAN, `清理动作里出现了 ${banned}：档案树的文件正被 Chromium 持有，只许走 Chromium 的淘汰路径`).not.toContain(banned)
    }
  })

  it('通道不收任何入参（要清的只有 default session 的 HTTP 缓存，不接受路径）', () => {
    const line = HANDLER.split(/\r?\n/).find((l) => l.includes('IPC.DATA_HEALTH_CLEAR_CACHE'))
    expect(line, 'steward.ts 里找不到这条通道').toBeTruthy()
    expect(line).not.toContain('argsSchema')
    expect(line).toContain('() => clearBrowserHttpCache()')
  })
})
