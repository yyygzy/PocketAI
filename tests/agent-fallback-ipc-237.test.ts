// V4-Iter-237 真跨桥：备用那两发跨过 preload → handler → zod → 服务层，形状逐字对上。
//
// 为什么还要一份（139 那条教训）：渲染层那些用例打的全是桩，桩给什么形状它就信什么。
// 而这一族的界面判据依赖三个真形状：
//  · 读回来的是**一张表**（对象），不是数组——`hasIpcFailed` 与 `res[key]` 都按对象写；
//  · 设成功时回的是 `{targets}`（界面以它为准、不做乐观更新），拒绝时 `rejected` 是真字符串；
//  · 非法入参被 zod 挡在门口 ⇒ `{ok:false, ipcCode:'IPC_ARG_INVALID'}`，是**返回值**不是 reject。
// 这三条只有真跨桥才证得到。库是真的、handler 是真的；只有 electron 是假的。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-237-ipc'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown
}))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => P.data, getAppPath: () => P.data, quit: () => {} },
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
  dialog: {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
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
import { registerAgentHandlers } from '../src/main/ipc/handlers/agent'
import { fallbackTargetKey } from '../src/shared/fallback-target'
import '../src/preload/index'
import { IPC } from '../src/shared/types'

const call = (name: string, ...args: unknown[]): Promise<any> => {
  const fn = (H.api as Record<string, unknown>)[name]
  if (typeof fn !== 'function') throw new Error(`preload 没暴露 ${name}`)
  return (fn as (...a: unknown[]) => Promise<any>)(...args)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerAgentHandlers()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

/**
 * 每条用例从空表起（走桥清，不用 raw SQL：这张表有一层内存 cache，绕过去会让"读回来是空的"
 * 变成假绿——第一版就有两条是被上一条用例写的 glm::glm-4.6 污染红的）。
 */
beforeEach(async () => {
  const table = await call('getFallbackTargets')
  for (const key of Object.keys(table ?? {})) {
    const i = key.indexOf('::')
    if (i < 0) continue
    await call('setFallbackTarget', key.slice(0, i), key.slice(i + 2), null)
  }
})

describe('两条新通道跨过桥之后的形状', () => {
  it('两侧同源：通道名确实注册在 ipcMain 上，preload 也真的暴露了两个方法', () => {
    expect(H.handlers.has(IPC.AGENT_GET_FALLBACKS)).toBe(true)
    expect(H.handlers.has(IPC.AGENT_SET_FALLBACK)).toBe(true)
    expect(typeof (H.api as Record<string, unknown>).getFallbackTargets).toBe('function')
    expect(typeof (H.api as Record<string, unknown>).setFallbackTarget).toBe('function')
  })

  it('读回来是一张表（对象）；设成功时回传最新表，界面无需自己乐观更新', async () => {
    const empty = await call('getFallbackTargets')
    expect(Array.isArray(empty)).toBe(false)
    expect(Object.keys(empty)).toHaveLength(0)

    const r = await call('setFallbackTarget', 'glm', 'glm-4.6', { providerId: 'ollama', model: 'qwen3:1.7b' })
    expect(r.rejected).toBeUndefined()
    expect(r.targets[fallbackTargetKey('glm', 'glm-4.6')]).toEqual({
      providerId: 'ollama',
      model: 'qwen3:1.7b'
    })
    // 再读一次拿到的就是同一份（说明真落库了，不是返回值好看）
    expect(await call('getFallbackTargets')).toEqual(r.targets)
  })

  it('清除走的是同一发（target=null），读回来又空了', async () => {
    await call('setFallbackTarget', 'glm', 'm', { providerId: 'ollama', model: 'x' })
    const cleared = await call('setFallbackTarget', 'glm', 'm', null)
    expect(Object.keys(cleared.targets)).toHaveLength(0)
    expect(Object.keys(await call('getFallbackTargets'))).toHaveLength(0)
  })

  it('缺字段与空串被 zod 挡在门口：{ok:false}＋IPC_ARG_INVALID，是返回值不是 reject', async () => {
    const noTarget = await call('setFallbackTarget', 'glm', 'm', undefined)
    expect(noTarget.ok).toBe(false)
    expect(noTarget.ipcCode).toBe('IPC_ARG_INVALID')
    const emptyId = await call('setFallbackTarget', '', 'm', { providerId: 'p', model: 'q' })
    expect(emptyId.ok).toBe(false)
    expect(emptyId.ipcCode).toBe('IPC_ARG_INVALID')
    const halfTarget = await call('setFallbackTarget', 'glm', 'm', { providerId: 'p' })
    expect(halfTarget.ok).toBe(false)
    expect(halfTarget.ipcCode).toBe('IPC_ARG_INVALID')
    // 挡下来之后库里仍然什么都没有（不许"拒了但顺手写了一半"）
    expect(Object.keys(await call('getFallbackTargets'))).toHaveLength(0)
  })

  it('服务层的语义拒绝（指向自己）走的是 rejected，不是 ok:false——两种失败面在界面上是两句话', async () => {
    const self = await call('setFallbackTarget', 'glm', 'm', { providerId: 'glm', model: 'm' })
    expect(self.ok).toBeUndefined()
    expect(self.rejected).toBe('FALLBACK_IS_SELF')
  })
})
