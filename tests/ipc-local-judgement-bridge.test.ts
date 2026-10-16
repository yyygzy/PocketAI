// 判据通道的真桥层往返（V4-Iter-146 / B81）
//
// 为什么单独立一份：139 的教训是「组件用例 + 主进程用例都绿，中间的桥可能整段没人测过」。
// 这条通道的**成功形状不带 ok 字段**（返回的是报告对象），恰好是 `isIpcFail = 'ok' in v` 那类判据会读错的一族；
// 而判据屏最怕的就是"把失败画成数据"——所以必须真跨过 preload 走一次，并另起一条真失败的对照。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-judgement-bridge'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

const H = vi.hoisted(() => ({
  handlers: new Map<string, (e: unknown, ...a: unknown[]) => unknown>(),
  api: null as unknown
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
// 现采显存走真 nvidia-smi：桥层用例只关心"跨不跨得过去"，不关心这台机器有没有独显
vi.mock('../src/main/steward/hardware', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readGpuMemoryLive: async () => [{ name: 'Mock GPU', totalMiB: 4096, usedMiB: 1234 }]
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
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { registerStewardHandlers } from '../src/main/ipc/handlers/steward'
import '../src/preload/index'
import { hasIpcFailed } from '../src/renderer/src/utils/ipc'
import { IPC } from '../src/shared/types'
import { configureLocalSlot, resetLocalSlotsForTest } from '../src/main/providers/local-slot'
import type { LocalJudgementReport } from '../src/shared/local-judgement'

const call = async (): Promise<unknown> => {
  const fn = (H.api as Record<string, unknown>).getLocalJudgement
  if (typeof fn !== 'function') throw new Error('preload 没暴露 getLocalJudgement')
  return (fn as () => Promise<unknown>)()
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  registerStewardHandlers()
  assistantRepo.save({ name: '桥测助手', systemPrompt: 'x', toolPermissions: ['time.now'], knowledgeBaseIds: [], skillIds: [] })
  appConfigRepo.set(
    'agent.delegate_capability',
    JSON.stringify([{ key: 'p::m', providerId: 'p', model: 'm', capability: 'native_tools_ok', samples: 3, nativeHits: 3, digest: '', checkedAt: 1 }])
  )
})

afterAll(() => {
  resetLocalSlotsForTest()
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('localJudgement:get 跨过真 preload', () => {
  it('通道常量、注册、preload 暴露名三处对齐（少任何一处，界面就是一块永远拿不到数的屏）', () => {
    expect(IPC.LOCAL_JUDGEMENT_GET).toBe('localJudgement:get')
    expect(H.handlers.has(IPC.LOCAL_JUDGEMENT_GET), '主进程没注册这条通道').toBe(true)
    expect(typeof (H.api as Record<string, unknown>).getLocalJudgement).toBe('function')
  })

  it('成功返回的是报告本体：**没有 ok 字段**，所以判失败只能用 hasIpcFailed', async () => {
    resetLocalSlotsForTest()
    configureLocalSlot({ readVramMiB: () => 4096 })
    const v = await call()
    expect(v, '成功形状若带 ok，isIpcFail 那类判据就会把成功读成失败').not.toHaveProperty('ok')
    expect(hasIpcFailed(v), '成功被读成失败：判据屏会一上线就报错').toBe(false)
    const r = v as LocalJudgementReport
    expect(r.totalVramMiB).toBe(4096)
    expect(r.capacity.measured).toBe(true)
    expect(r.liveVram.available).toBe(true)
    expect(r.roleVerdicts.map((x) => x.assistantName)).toContain('桥测助手')
    expect(r.delegations[0]).toMatchObject({ key: 'p::m', nativeHits: 3, delegationEnabled: false })
    // 结构化克隆会把方法/undefined 字段抹平：这里确认数组与布尔都还在（渲染层靠它们出文案）
    expect(Array.isArray(r.slots)).toBe(true)
    expect(typeof r.collectedAt).toBe('number')
  })

  it('真失败（库已关）⇒ 返回 {ok:false,error} 而不是 rejection，且 hasIpcFailed 认得它', async () => {
    // 顺序敏感：这条必须放最后——它把库关掉，之后任何用例都拿不到数据
    dbService.close()
    const v = await call()
    expect(v, 'safeHandle 的失败是返回值：不能让它变成 rejection 让界面卡在 loading').not.toBeInstanceOf(Error)
    expect(hasIpcFailed(v)).toBe(true)
    expect(String((v as { error?: string }).error ?? '').length).toBeGreaterThan(0)
  })
})
