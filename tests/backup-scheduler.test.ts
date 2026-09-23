// backup-scheduler 定时 WebDAV 备份调度器测试
//
// 覆盖 src/main/backup/backup-scheduler.ts 核心路径：
// - getBackupSchedule：字段解析 / 默认值 / 非法值兜底 / lastResult JSON 容错
// - setBackupSchedule：启用时刷 lastRunAt 避免开启瞬间立即备份 / intervalHours<=0 忽略
// - runScheduledBackup：成功 / 失败 / 抛错 / running 互斥
// - noteManualBackup：写 lastRunAt 避免调度器重复备份
// - tick：跳过条件（未启用 / 锁定中 / 无 WebDAV / 未到点）+ 到点执行 + 异常容错
// - initBackupScheduler / stopBackupScheduler：不重复注册 timer
//
// 策略：
// - vi.hoisted 集中 mocks 状态，每用例 reset 后注入场景
// - vi.mock appConfigRepo（Map 模拟 get/set）/ masterKeyManager / backup-service / logger
// - runScheduledBackup 的 running 互斥用可控 promise 验证
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getBackupSchedule,
  setBackupSchedule,
  runScheduledBackup,
  noteManualBackup,
  tick,
  initBackupScheduler,
  stopBackupScheduler
} from '../src/main/backup/backup-scheduler'

// ---------- mock 工厂 ----------

const mocks = vi.hoisted(() => ({
  // app_config 键值表
  config: new Map<string, string>(),
  configGetThrows: false,
  // 加密 / 锁
  dbMode: 'none' as string,
  unlocked: false,
  // WebDAV 配置
  webdavCfg: null as unknown,
  // createWebDAVBackup 行为：优先 controllable，否则按 result/error
  backupResult: null as { filename: string; size: number; encrypted: boolean } | null,
  backupError: null as Error | null,
  backupImpl: null as null | (() => Promise<{ filename: string; size: number; encrypted: boolean }>),
  backupCalls: 0,
  reset() {
    this.config.clear()
    this.configGetThrows = false
    this.dbMode = 'none'
    this.unlocked = false
    this.webdavCfg = null
    this.backupResult = null
    this.backupError = null
    this.backupImpl = null
    this.backupCalls = 0
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => {
      if (mocks.configGetThrows) throw new Error('config 读失败')
      return mocks.config.get(key) ?? null
    },
    set: (key: string, value: string) => {
      mocks.config.set(key, value)
    }
  }
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getMode: () => mocks.dbMode,
    hasKey: () => mocks.unlocked
  }
}))

vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => mocks.webdavCfg,
  createWebDAVBackup: async () => {
    mocks.backupCalls++
    if (mocks.backupImpl) return await mocks.backupImpl()
    if (mocks.backupError) throw mocks.backupError
    if (mocks.backupResult) return mocks.backupResult
    throw new Error('未配置 WebDAV')
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

beforeEach(() => mocks.reset())

// ---------- getBackupSchedule ----------

describe('getBackupSchedule 字段解析', () => {
  it('全空配置：enabled=false / intervalHours=24 / lastRunAt=null / lastResult=null', () => {
    const s = getBackupSchedule()
    expect(s.enabled).toBe(false)
    expect(s.intervalHours).toBe(24)
    expect(s.lastRunAt).toBeNull()
    expect(s.lastResult).toBeNull()
  })

  it('自定义值：enabled=true / intervalHours=12 / lastRunAt 时间戳 / lastResult JSON 解析', () => {
    mocks.config.set('backup.schedule_enabled', '1')
    mocks.config.set('backup.schedule_interval_hours', '12')
    mocks.config.set('backup.last_run_at', '1000')
    mocks.config.set('backup.last_result', JSON.stringify({ ok: true, at: 1000, filename: 'b.zip' }))
    const s = getBackupSchedule()
    expect(s.enabled).toBe(true)
    expect(s.intervalHours).toBe(12)
    expect(s.lastRunAt).toBe(1000)
    expect(s.lastResult).toEqual({ ok: true, at: 1000, filename: 'b.zip' })
  })

  it('intervalHours 非法（0 / NaN / 负数）：兜底 24', () => {
    for (const v of ['0', 'abc', '-5']) {
      mocks.config.set('backup.schedule_interval_hours', v)
      expect(getBackupSchedule().intervalHours).toBe(24)
      mocks.config.clear()
    }
  })

  it('lastResult JSON 损坏：返回 null', () => {
    mocks.config.set('backup.last_result', '{not json')
    expect(getBackupSchedule().lastResult).toBeNull()
  })
})

// ---------- setBackupSchedule ----------

describe('setBackupSchedule 配置写入', () => {
  it('enabled=true：写 1 且刷 last_run_at 为当前时间，避免开启瞬间立即备份', () => {
    const before = Date.now()
    setBackupSchedule({ enabled: true })
    const after = Date.now()
    expect(mocks.config.get('backup.schedule_enabled')).toBe('1')
    const ts = Number(mocks.config.get('backup.last_run_at'))
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })

  it('enabled=false：写 0 且不刷 last_run_at', () => {
    mocks.config.set('backup.last_run_at', '111')
    setBackupSchedule({ enabled: false })
    expect(mocks.config.get('backup.schedule_enabled')).toBe('0')
    expect(mocks.config.get('backup.last_run_at')).toBe('111')
  })

  it('intervalHours>0 才写；<=0 忽略', () => {
    setBackupSchedule({ intervalHours: 6 })
    expect(mocks.config.get('backup.schedule_interval_hours')).toBe('6')
    mocks.config.delete('backup.schedule_interval_hours')
    setBackupSchedule({ intervalHours: 0 })
    expect(mocks.config.get('backup.schedule_interval_hours')).toBeUndefined()
    setBackupSchedule({ intervalHours: -3 })
    expect(mocks.config.get('backup.schedule_interval_hours')).toBeUndefined()
  })
})

// ---------- runScheduledBackup ----------

describe('runScheduledBackup 执行与互斥', () => {
  it('成功路径：cfg 存在 + backup 成功 → {ok,at,filename}，持久化 last_run_at + last_result', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backupResult = { filename: 'b.zip', size: 100, encrypted: true }
    const before = Date.now()
    const r = await runScheduledBackup()
    const after = Date.now()
    expect(r?.ok).toBe(true)
    expect(r?.filename).toBe('b.zip')
    expect(r!.at).toBeGreaterThanOrEqual(before)
    expect(r!.at).toBeLessThanOrEqual(after)
    // 持久化
    expect(Number(mocks.config.get('backup.last_run_at'))).toBe(r!.at)
    const stored = JSON.parse(mocks.config.get('backup.last_result')!)
    expect(stored).toEqual({ ok: true, at: r!.at, filename: 'b.zip' })
  })

  it('失败路径：loadWebDAVConfig 返回 null → 抛错 → {ok:false,at,error}，仍持久化', async () => {
    mocks.webdavCfg = null
    const r = await runScheduledBackup()
    expect(r?.ok).toBe(false)
    expect(r?.error).toBeTruthy()
    expect(mocks.config.get('backup.last_run_at')).toBeDefined()
    const stored = JSON.parse(mocks.config.get('backup.last_result')!)
    expect(stored.ok).toBe(false)
    expect(stored.error).toBeTruthy()
  })

  it('createWebDAVBackup 抛错：返回 {ok:false,error} 并持久化', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backupError = new Error('网络超时')
    const r = await runScheduledBackup()
    expect(r?.ok).toBe(false)
    expect(r?.error).toContain('网络超时')
    const stored = JSON.parse(mocks.config.get('backup.last_result')!)
    expect(stored.ok).toBe(false)
  })

  it('running 互斥：第一次未完成时第二次返回 null', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    // 用可控 promise 让第一次调用挂起
    let resolveFirst: (v: { filename: string; size: number; encrypted: boolean }) => void = () => {}
    mocks.backupImpl = () => new Promise((resolve) => {
      resolveFirst = resolve
    })
    const p1 = runScheduledBackup() // 不 await，内部 running=true
    const p2 = await runScheduledBackup()
    expect(p2).toBeNull() // running 占着，立即返回 null
    resolveFirst({ filename: 'x.zip', size: 1, encrypted: false })
    const r1 = await p1
    expect(r1?.ok).toBe(true)
  })
})

// ---------- noteManualBackup ----------

describe('noteManualBackup', () => {
  it('写 last_run_at 为当前时间，避免调度器紧接着重复备份', () => {
    const before = Date.now()
    noteManualBackup()
    const after = Date.now()
    const ts = Number(mocks.config.get('backup.last_run_at'))
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

// ---------- tick ----------

describe('tick 跳过条件与到点执行', () => {
  it('未启用 → 不执行 backup', async () => {
    await tick()
    expect(mocks.backupCalls).toBe(0)
  })

  it('隐私锁锁定中（mode=db 且 !hasKey）→ 不执行', async () => {
    mocks.config.set('backup.schedule_enabled', '1')
    mocks.dbMode = 'db'
    mocks.unlocked = false
    mocks.webdavCfg = { host: 'dav.example.com' }
    await tick()
    expect(mocks.backupCalls).toBe(0)
  })

  it('无 WebDAV 配置 → 不执行', async () => {
    mocks.config.set('backup.schedule_enabled', '1')
    mocks.dbMode = 'none'
    mocks.webdavCfg = null
    await tick()
    expect(mocks.backupCalls).toBe(0)
  })

  it('未到点（lastRunAt + interval 未满）→ 不执行', async () => {
    mocks.config.set('backup.schedule_enabled', '1')
    mocks.config.set('backup.schedule_interval_hours', '24')
    mocks.config.set('backup.last_run_at', String(Date.now() - 1 * 3600 * 1000)) // 1 小时前
    mocks.dbMode = 'none'
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backupResult = { filename: 'b.zip', size: 1, encrypted: true }
    await tick()
    expect(mocks.backupCalls).toBe(0)
  })

  it('到点（lastRunAt + interval 已满）→ 执行 backup', async () => {
    mocks.config.set('backup.schedule_enabled', '1')
    mocks.config.set('backup.schedule_interval_hours', '24')
    mocks.config.set('backup.last_run_at', String(Date.now() - 25 * 3600 * 1000)) // 25 小时前
    mocks.dbMode = 'none'
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backupResult = { filename: 'b.zip', size: 1, encrypted: true }
    await tick()
    expect(mocks.backupCalls).toBe(1)
  })

  it('启用但从未记录 lastRunAt → 补一次（due=true）', async () => {
    mocks.config.set('backup.schedule_enabled', '1')
    mocks.config.set('backup.schedule_interval_hours', '24')
    // 不设 last_run_at
    mocks.dbMode = 'none'
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backupResult = { filename: 'b.zip', size: 1, encrypted: true }
    await tick()
    expect(mocks.backupCalls).toBe(1)
  })

  it('tick 异常容错：getBackupSchedule 抛错时不传播', async () => {
    mocks.configGetThrows = true
    // 不应抛错
    await expect(tick()).resolves.toBeUndefined()
    expect(mocks.backupCalls).toBe(0)
  })
})

// ---------- init / stop ----------

describe('initBackupScheduler / stopBackupScheduler', () => {
  afterEach(() => {
    stopBackupScheduler()
    vi.useRealTimers()
  })

  it('init 注册 timer 且重复调用不重复注册；stop 后再 init 才重新注册', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    initBackupScheduler()
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    // 重复调用：timer 已存在，不再注册
    initBackupScheduler()
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    // stop 清除后，再 init 应重新注册
    stopBackupScheduler()
    initBackupScheduler()
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)
  })
})
