// dataHealth:get 这一跳的参数契约（V4-Iter-177）
//
// 为什么值得单独一条：`refresh` 是**新加的可选入参**，两端各写一次（preload 的默认值、handler 的透传）。
// 少写一处不会编译错、也不会让面板用例红（那 14 例打的是桩），
// 后果是"按刷新其实没重算缓存"——一个只在真机上、而且只在数完 21,103 个文件之后才看得见的错。
// 所以这里真跨一次：真 preload 暴露的 api + 真注册的 handler。
import { describe, it, expect, vi } from 'vitest'

const H = vi.hoisted(() => ({ handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(), api: null as unknown }))

const seen: Array<{ refresh: boolean }> = []
vi.mock('../src/main/steward/data-health', () => ({
  // 只替这一层：报告内容不重要，重要的是 handler 把 refresh 原样递了进来
  getDataHealthReport: (opts: { refresh?: boolean } = {}) => {
    const refresh = !!opts.refresh
    seen.push({ refresh })
    return { sizes: { userDataBytes: 1, browserCacheBytes: 2, browserCacheFiles: 3 } }
  }
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
  BrowserWindow: class {
    static fromWebContents() { return undefined }
    static getAllWindows() { return [] }
  },
  nativeImage: { createFromPath: () => ({}) }
}))

import { registerStewardHandlers } from '../src/main/ipc/handlers/steward'
import '../src/preload/index'

type Api = { getDataHealth: (refresh?: boolean) => Promise<{ sizes: Record<string, number> }> }

const getDataHealth = (): Api['getDataHealth'] => {
  const fn = (H.api as Record<string, unknown>).getDataHealth
  if (typeof fn !== 'function') throw new Error('preload 没暴露 getDataHealth')
  return fn as Api['getDataHealth']
}

describe('dataHealth:get 的 refresh 参数', () => {
  it('挂载路径（不传参）与显式 false 都按"不重算"送到主进程', async () => {
    registerStewardHandlers()
    seen.length = 0
    await getDataHealth()()
    await getDataHealth()(false)
    expect(seen).toEqual([{ refresh: false }, { refresh: false }])
  })

  it('refresh=true 一路透传到聚合函数（缓存那一格只有这条路会重算）', async () => {
    registerStewardHandlers()
    seen.length = 0
    const r = await getDataHealth()(true)
    expect(seen).toEqual([{ refresh: true }])
    expect(r.sizes.browserCacheFiles).toBe(3)
  })
})
