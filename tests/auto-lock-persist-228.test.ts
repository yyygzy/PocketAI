// @vitest-environment node
// V4-Iter-228：自动锁屏那一档过去**只改内存、从不落库**（`appConfigRepo.setAutoLockTimeout` 零调用点），
// 启动也没有读回来 ⇒ 设了 5 分钟、重启回到「永不」，而设置页显示的正是那格（§227 撞出来的附带发现）。
//
// 这里用**真实 SQLite**（内存库）跑真 `appConfigRepo` 的 SQL 与真 `LockService`，只打桩两处边界：
// `electron`（捕获 ipcMain.handle）与 `dbService.getHandle()`（换成真句柄）。理由与 §170/§139 同：
// 这一批的承重命题就是"值有没有落到盘上"，桩住盘就等于没测。
//
// 顺序也是这批的设计判据：**先落库、再改内存**。反过来会造出"内存已改、盘上没改"的那一半，
// 正是这次要修的 bug 的新版本——所以第 ② 条用例专门把库写坏（真抛错）来证内存没被动过。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import fs from 'node:fs'
import path from 'node:path'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { mocks.handlers.set(ch, fn); return true } },
  BrowserWindow: class { static getAllWindows() { return [] } static fromWebContents() { return undefined } },
  dialog: { showErrorBox: () => {} },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd(), quit: () => {} }
}))

const mem = new Database(':memory:')
const DDL = 'CREATE TABLE app_config (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER NOT NULL)'
mem.exec(DDL)

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => mem,
    isOpen: () => true,
    open: () => {},
    close: () => {},
    runMigrations: () => {},
    getEncryptionMode: () => 'none'
  }
}))
// 这一批发的是"落库＋启动恢复"，锁状态与密钥层只是背景：桩掉，但**不桩** app-config.repo 与 lock.ts
vi.mock('../src/main/crypto/master-key', () => ({ masterKeyManager: { getMode: () => 'none', hasKey: () => false } }))
vi.mock('../src/main/crypto/master-password', () => ({ verifyAndOpenMasterKey: () => true }))
vi.mock('../src/main/crypto/clipboard-guard', () => ({ clipboardGuard: { purge: () => {} } }))
vi.mock('../src/main/ipc/broadcast', () => ({ broadcast: () => {} }))

import { IPC } from '../src/shared/types'
import { registerLockHandlers } from '../src/main/ipc/handlers/lock'
import { appConfigRepo, clearAppConfigCache } from '../src/main/db/repositories/app-config.repo'
import { LockService, lockService } from '../src/main/lock/lock'

registerLockHandlers()
type Ret = { ok?: boolean; error?: string; ipcCode?: string }
/** safeHandle 注册的是 async 包装，所以必须 await 才拿得到返回值（不 await 就会读到一个 Promise） */
const setAuto = async (ms: unknown): Promise<Ret> =>
  (await mocks.handlers.get(IPC.LOCK_SET_AUTO_TIMEOUT)!({ sender: {} }, ms)) as Ret
const rawRow = (): { value: string | null } | undefined =>
  mem.prepare('SELECT value FROM app_config WHERE key = ?').get('auto_lock_timeout') as { value: string | null } | undefined

beforeEach(() => {
  // 每条用例都换一张干净的表：② 会把表 DROP 掉，不留这一步就会串到后面（第一版就串了九条）
  mem.exec('DROP TABLE IF EXISTS app_config')
  mem.exec(DDL)
  clearAppConfigCache()
  lockService.setAutoTimeout(0)
})
afterEach(() => vi.useRealTimers())

describe('① 写这一发现在真的落库', () => {
  it('handler(300000) ⇒ 表里真有一行 auto_lock_timeout=300000，内存同步跟上', async () => {
    expect(await setAuto(300_000)).toEqual({ ok: true })
    expect(rawRow()?.value).toBe('300000')
    clearAppConfigCache() // 绕过缓存，让下面这一读真的走 SQL
    expect(appConfigRepo.getAutoLockTimeout()).toBe(300_000)
    expect(lockService.getStatus().autoLockTimeout).toBe(300_000)
  })

  it('0 是合法值（「永不」也要能存下来，不能只存非零）', async () => {
    expect(await setAuto(0)).toEqual({ ok: true })
    expect(rawRow()?.value).toBe('0')
    clearAppConfigCache()
    expect(appConfigRepo.getAutoLockTimeout()).toBe(0)
  })

  it('入参不是整数 ⇒ zod 挡下、库里不写、内存也不改（§209 那张网还在这条通道上）', async () => {
    const r = await setAuto(250_000.5)
    expect(r.ok).toBe(false)
    expect(r.ipcCode).toBe('IPC_ARG_INVALID')
    expect(rawRow()).toBeUndefined()
    expect(lockService.getStatus().autoLockTimeout).toBe(0)
  })
})

describe('② 顺序：先落库、再改内存（写失败不许留下"内存已改、盘上没改"的那一半）', () => {
  it('库写不进去（表被删＝真抛错）⇒ 返回 {ok:false}，内存保持原值', async () => {
    await setAuto(300_000)
    expect(lockService.getStatus().autoLockTimeout).toBe(300_000)
    mem.exec('DROP TABLE app_config')
    const r = await setAuto(60_000)
    expect(r.ok).toBe(false)
    expect(typeof r.error).toBe('string')
    // 关键：这一发**没有**把内存改成 60000——旧值留在内存里，界面上由 §228 的回滚＋说话接管
    expect(lockService.getStatus().autoLockTimeout).toBe(300_000)
  })
})

describe('③ 启动恢复：从库里读回来，并真的按那档锁', () => {
  /** 与 index.ts 阶段 7 那一行等价的调用序列（那一行本身由本块最后那条源码断言钉住） */
  const restoreInto = (svc: LockService): number => {
    const stored = appConfigRepo.getAutoLockTimeout()
    svc.setAutoTimeout(stored)
    return stored
  }

  it('库里是 5 分钟 ⇒ 全新 LockService 恢复后按 5 分钟自动锁（reason=auto-timeout）', async () => {
    await setAuto(300_000)
    vi.useFakeTimers({ now: 0 })
    const fresh = new LockService()
    expect(restoreInto(fresh)).toBe(300_000)
    const reasons: string[] = []
    fresh.onStateChange((e) => reasons.push(e.reason))
    fresh.init()
    vi.advanceTimersByTime(300_000 + 10_000)
    expect(reasons).toEqual(['auto-timeout'])
    expect(fresh.getStatus().state).toBe('locked')
    fresh.destroy()
  })

  it('库里是 0 ⇒ 恢复后不锁（「永不」是合法档，不是"没读到"）', async () => {
    await setAuto(0)
    vi.useFakeTimers({ now: 0 })
    const fresh = new LockService()
    restoreInto(fresh)
    const reasons: string[] = []
    fresh.onStateChange((e) => reasons.push(e.reason))
    fresh.init()
    vi.advanceTimersByTime(3_600_000)
    expect(reasons).toEqual([])
    fresh.destroy()
  })

  it('库里是坏值（非数字／负数）⇒ 归到「永不」，不让 NaN 进到计时判据里', () => {
    for (const bad of ['abc', '-5']) {
      mem.prepare('DELETE FROM app_config').run()
      mem.prepare('INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)').run('auto_lock_timeout', bad, 1)
      clearAppConfigCache()
      const fresh = new LockService()
      restoreInto(fresh)
      expect(fresh.getStatus().autoLockTimeout).toBe(0)
      fresh.destroy()
    }
  })

  it('恢复那一步必须在 lockService.init() **之前**（init 起的就是那根 10s 轮询）', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf-8').replace(/\r\n/g, '\n')
    const restoreLine = 'lockService.setAutoTimeout(appConfigRepo.getAutoLockTimeout())'
    expect(src.split(restoreLine).length - 1, '启动恢复那一行不在或不止一处').toBe(1)
    // 锚必须带行首：我在那两行注释里也写了 `lockService.init()` 这一串，不带缩进会先撞上注释
    const initLine = String.fromCharCode(10) + '  lockService.init()'
    expect(src.split(initLine).length - 1, 'init 那行的锚不止一处').toBe(1)
    const restore = src.indexOf(restoreLine)
    const init = src.indexOf(initLine)
    expect(init, 'lockService.init() 没找到').toBeGreaterThan(-1)
    expect(restore, '恢复必须在 init 之前').toBeLessThan(init)
  })
})

describe('④ 落库之后，管家那条检查读的就是同一份', () => {
  it('diagnose 读的 appConfigRepo.getAutoLockTimeout() 现在有真值（过去恒为 0）', async () => {
    await setAuto(900_000)
    clearAppConfigCache()
    expect(appConfigRepo.getAutoLockTimeout()).toBe(900_000)
  })
})
