// update-manager 更新管理器测试
//
// 覆盖 src/main/update-manager.ts 的 UpdateManager：
// - init：dev 环境读开关并置 unavailable
// - check：busy 互斥 / dev 拒绝 / linux 无 APPIMAGE / win32 便携 / 上游抛错收敛
// - download：状态门 / dev 拒绝 / busy 互斥 / 增量补丁成功 / 回退全量 / 抛错 + keep-awake 释放
// - quitAndInstall：状态门 / 补丁待应用重启 / NSIS 安装
// - setAutoUpdate：持久化 / 失败收敛 / dev 开启不触发 check
// - getInfo / getStatusSnapshot
//
// 策略：vi.mock electron / electron-updater / keep-awake / app-config / asar-patcher /
// portable / safe-handle / safe-fetch；autoUpdater 用 listener Map 可触发事件。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { updateManager, initUpdateManager } from '../src/main/update-manager'

const mocks = vi.hoisted(() => ({
  isPackaged: false,
  isPortable: false,
  autoEnabled: false,
  setAutoEnabledCalls: [] as boolean[],
  setAutoEnabledThrows: false,
  // autoUpdater 事件回调表（init 时注册）
  listeners: new Map<string, (info: unknown) => void>(),
  checkForUpdatesError: null as Error | null,
  checkCalls: 0,
  downloadUpdateError: null as Error | null,
  downloadCalls: 0,
  quitInstallCalls: [] as unknown[][],
  // asar-patcher
  patchResult: null as { ok: boolean; patchBytes?: number; newSize?: number } | null,
  patchThrows: false,
  patchPending: false,
  restartCalls: 0,
  restartThrows: false,
  // keep-awake 调用顺序
  keepAwakeCalls: [] as string[],
  reset() {
    this.isPackaged = false
    this.isPortable = false
    this.autoEnabled = false
    this.setAutoEnabledCalls = []
    this.setAutoEnabledThrows = false
    this.listeners = new Map()
    this.checkForUpdatesError = null
    this.checkCalls = 0
    this.downloadUpdateError = null
    this.downloadCalls = 0
    this.quitInstallCalls = []
    this.patchResult = null
    this.patchThrows = false
    this.patchPending = false
    this.restartCalls = 0
    this.restartThrows = false
    this.keepAwakeCalls = []
  }
}))

vi.mock('electron', () => ({
  app: {
    get isPackaged() { return mocks.isPackaged },
    getVersion: () => '1.2.7'
  },
  webContents: { getAllWebContents: () => [] }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: (ev: string, cb: (info: unknown) => void) => { mocks.listeners.set(ev, cb) },
    autoDownload: false,
    autoInstallOnAppQuit: false,
    checkForUpdates: async () => {
      mocks.checkCalls++
      if (mocks.checkForUpdatesError) throw mocks.checkForUpdatesError
    },
    downloadUpdate: async () => {
      mocks.downloadCalls++
      if (mocks.downloadUpdateError) throw mocks.downloadUpdateError
    },
    quitAndInstall: (...a: unknown[]) => { mocks.quitInstallCalls.push(a) }
  }
}))

vi.mock('../src/main/keep-awake', () => ({
  acquireKeepAwake: () => { mocks.keepAwakeCalls.push('acquire') },
  releaseKeepAwake: () => { mocks.keepAwakeCalls.push('release') }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    isAutoUpdateEnabled: () => mocks.autoEnabled,
    setAutoUpdateEnabled: (v: boolean) => {
      if (mocks.setAutoEnabledThrows) throw new Error('配置写入失败')
      mocks.setAutoEnabledCalls.push(v)
    }
  }
}))

vi.mock('../src/main/update/asar-patcher', () => ({
  downloadAsarPatch: async () => {
    if (mocks.patchThrows) throw new Error('补丁下载失败')
    return mocks.patchResult ?? { ok: false }
  },
  restartToApplyPatch: () => {
    if (mocks.restartThrows) throw new Error('重启失败')
    mocks.restartCalls++
  },
  isPatchPending: () => mocks.patchPending
}))

vi.mock('../src/main/portable', () => ({
  isPortableRuntime: () => mocks.isPortable
}))

vi.mock('../src/main/ipc/safe-handle', () => ({
  safeHandle: () => {},
  argsSchema: (s: unknown) => s,
  z: { boolean: () => ({}) }
}))

vi.mock('../src/main/net/safe-fetch', () => ({
  safeFetch: async () => ({ status: 200, body: Buffer.from('[]') })
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

function emit(ev: string, info: unknown = {}): void {
  mocks.listeners.get(ev)?.(info)
}

function goPackaged(): void {
  mocks.isPackaged = true
  updateManager.init() // 注册 autoUpdater 事件回调
}

beforeEach(() => mocks.reset())

afterEach(() => {
  // 释放可能残留的 busy 锁：unavailable 属解锁状态且不写 this.error（避免跨用例污染）
  goPackaged()
  emit('update-not-available', { version: '' })
})

// ---------- init / getInfo / snapshot ----------

describe('init 与状态查询', () => {
  it('dev 环境 init：读开关并置 unavailable', () => {
    const seen: unknown[] = []
    updateManager.on('status', (e) => seen.push(e))
    updateManager.init()
    expect(seen[0]).toMatchObject({ status: 'unavailable', error: expect.stringContaining('开发环境') })
  })

  it('getInfo：版本 / 打包态 / 自动更新开关', () => {
    mocks.isPackaged = true
    const info = updateManager.getInfo()
    expect(info).toEqual({
      currentVersion: '1.2.7',
      isPackaged: true,
      isPortable: false,
      autoUpdateEnabled: false
    })
  })

  it('getStatusSnapshot：字段结构完整（单例状态跨用例共享，不断言具体 status）', () => {
    const s = updateManager.getStatusSnapshot()
    expect(s).toHaveProperty('status')
    expect(s).toHaveProperty('newVersion')
    expect(typeof s.progress).toBe('number')
    expect(s.error === undefined || typeof s.error === 'string').toBe(true)
  })
})

// ---------- check ----------

describe('check 检查更新', () => {
  it('busy 互斥：进行中再查返回锁错误', async () => {
    goPackaged()
    const p1 = updateManager.check() // 同步段已置 busy，checkForUpdates 尚未完成
    const r2 = await updateManager.check()
    expect(r2).toEqual({ ok: false, error: '正在进行中的更新流程' })
    await p1
  })

  it('dev 环境：置 unavailable 并返回 ok:true（不触上游）', async () => {
    const r = await updateManager.check()
    expect(r).toEqual({ ok: true })
    expect(updateManager.getStatusSnapshot().status).toBe('unavailable')
    expect(mocks.checkCalls).toBe(0)
  })

  it('linux 无 APPIMAGE：置 unavailable', async () => {
    goPackaged()
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env.APPIMAGE
    try {
      const r = await updateManager.check()
      expect(r).toEqual({ ok: true })
      expect(updateManager.getStatusSnapshot().status).toBe('unavailable')
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
    expect(mocks.checkCalls).toBe(0)
  })

  it('win32 便携形态：置 unavailable', async () => {
    goPackaged()
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    mocks.isPortable = true
    try {
      const r = await updateManager.check()
      expect(r).toEqual({ ok: true })
      expect(updateManager.getStatusSnapshot().status).toBe('unavailable')
    } finally {
      Object.defineProperty(process, 'platform', real)
    }
  })

  it('打包环境上游抛错：收敛 {ok:false,error} 并置 error 状态', async () => {
    goPackaged()
    mocks.checkForUpdatesError = new Error('网络断开')
    const r = await updateManager.check()
    expect(r).toEqual({ ok: false, error: '网络断开' })
    expect(updateManager.getStatusSnapshot().status).toBe('error')
  })

  it('打包环境成功：ok:true 且收到 update-available 后状态与版本更新', async () => {
    goPackaged()
    const r = await updateManager.check()
    expect(r).toEqual({ ok: true })
    emit('update-available', { version: '1.3.0' })
    const s = updateManager.getStatusSnapshot()
    expect(s.status).toBe('available')
    expect(s.newVersion).toBe('1.3.0')
  })
})

// ---------- download ----------

describe('download 下载更新', () => {
  it('状态门：非 available 返回错误', async () => {
    goPackaged()
    const r = await updateManager.download()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('需要先检查更新')
  })

  it('dev 环境（状态已 available）：拒绝下载', async () => {
    goPackaged()
    emit('update-available', { version: '1.3.0' })
    mocks.isPackaged = false
    const r = await updateManager.download()
    expect(r).toEqual({ ok: false, error: '开发环境不支持下载' })
  })

  it('busy 互斥：下载中再下返回锁错误', async () => {
    goPackaged()
    emit('update-available', { version: '1.3.0' })
    // 挂起第一次：让 downloadUpdate 永不返回前 busy 锁占住
    mocks.downloadUpdateError = new Error('x')
    const p = updateManager.download() // 失败路径但先置 busy
    const r2 = await updateManager.download()
    expect(r2.ok).toBe(false)
    expect(r2.error).toContain('正在进行中的更新流程')
    await p
  })

  it('增量补丁成功：不走全量，置 downloaded，keep-awake 成对调用', async () => {
    goPackaged()
    emit('update-available', { version: '1.3.0' })
    mocks.isPortable = false
    mocks.patchResult = { ok: true, patchBytes: 1024, newSize: 4096 }
    const r = await updateManager.download()
    expect(r).toEqual({ ok: true })
    const s = updateManager.getStatusSnapshot()
    expect(s.status).toBe('downloaded')
    expect(mocks.downloadCalls).toBe(0)
    expect(mocks.keepAwakeCalls).toEqual(['acquire', 'release'])
  })

  it('增量不可用回退全量：downloadUpdate 被调用', async () => {
    goPackaged()
    emit('update-available', { version: '1.3.0' })
    mocks.patchResult = { ok: false }
    const r = await updateManager.download()
    expect(r).toEqual({ ok: true })
    expect(mocks.downloadCalls).toBe(1)
  })

  it('全量也抛错：{ok:false} 且 keep-awake 仍释放', async () => {
    goPackaged()
    emit('update-available', { version: '1.3.0' })
    mocks.downloadUpdateError = new Error('磁盘满')
    const r = await updateManager.download()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('磁盘满')
    expect(mocks.keepAwakeCalls).toEqual(['acquire', 'release'])
  })
})

// ---------- quitAndInstall ----------

describe('quitAndInstall 退出安装', () => {
  it('状态门：非 downloaded 拒绝', async () => {
    goPackaged()
    const r = await updateManager.quitAndInstall()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('需要先下载完成')
  })

  it('补丁待应用：走 restartToApplyPatch 而非 NSIS', async () => {
    goPackaged()
    emit('update-downloaded', { version: '1.3.0' })
    mocks.patchPending = true
    const r = await updateManager.quitAndInstall()
    expect(r).toEqual({ ok: true })
    expect(mocks.restartCalls).toBe(1)
    expect(mocks.quitInstallCalls).toHaveLength(0)
  })

  it('常规路径：调 autoUpdater.quitAndInstall(true, true) 静默安装', async () => {
    goPackaged()
    emit('update-downloaded', { version: '1.3.0' })
    const r = await updateManager.quitAndInstall()
    expect(r).toEqual({ ok: true })
    expect(mocks.quitInstallCalls).toEqual([[true, true]])
  })
})

// ---------- setAutoUpdate ----------

describe('setAutoUpdate 自动更新开关', () => {
  it('开启：持久化写 true 且 dev 不触发 check', async () => {
    const r = await updateManager.setAutoUpdate(true)
    expect(r).toEqual({ ok: true })
    expect(mocks.setAutoEnabledCalls).toEqual([true])
    expect(mocks.checkCalls).toBe(0)
  })

  it('持久化抛错：收敛 {ok:false,error}', async () => {
    mocks.setAutoEnabledThrows = true
    const r = await updateManager.setAutoUpdate(true)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('配置写入失败')
  })

  it('关闭：写 false，不触发 check', async () => {
    const r = await updateManager.setAutoUpdate(false)
    expect(r).toEqual({ ok: true })
    expect(mocks.setAutoEnabledCalls).toEqual([false])
  })
})

// ---------- initUpdateManager（IPC 注册入口）----------

describe('initUpdateManager', () => {
  it('不抛错即可完成（safeHandle 已 mock，注册逻辑在打包路径外不执行 updater）', () => {
    expect(() => initUpdateManager()).not.toThrow()
  })
})
