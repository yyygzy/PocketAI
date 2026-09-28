// task-scheduler 通用定时任务调度器测试
//
// 覆盖 src/main/backup/task-scheduler.ts 核心路径：
// - tick：从未运行 → 补跑；到点/未到点判定；两任务互不干扰；异常容错
// - kb_health_check：卡住文档（pending/parsing/indexing 超 1h）标记 error；未超时不标记；非卡状态不动
// - backup_verify：无配置 / 无备份跳过；全量 zip sha256 / 加密解密 / 增量索引校验 / 索引无效抛错
// - initTaskScheduler / stopTaskScheduler：60s 首跑 + 10min 周期 + 不重复注册 + stop 停止
//
// 策略：
// - vi.hoisted 集中 mocks 状态，每用例 reset 后注入场景
// - vi.mock appConfigRepo（Map 模拟 get/set）/ kbDocRepo / backup-service / webdav-client / logger
// - 调度周期用 fake timers 推进验证
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tick, initTaskScheduler, stopTaskScheduler } from '../src/main/backup/task-scheduler'

// ---------- mock 工厂 ----------

const mocks = vi.hoisted(() => ({
  // app_config 键值表
  config: new Map<string, string>(),
  // kb 文档与 setStatus 调用记录
  docs: [] as Array<{ id: string; status: string; createdAt: number }>,
  statusCalls: [] as Array<{ id: string; status: string; error?: string | null }>,
  // WebDAV
  webdavCfg: null as unknown,
  backups: [] as Array<{ name: string }>,
  downloadRaw: Buffer.from('raw'),
  encrypted: false,
  decryptedRaw: Buffer.from('decrypted'),
  downloadCalls: 0,
  decryptCalls: 0,
  listBackupsError: null as Error | null,
  reset() {
    this.config.clear()
    this.docs = []
    this.statusCalls = []
    this.webdavCfg = null
    this.backups = []
    this.downloadRaw = Buffer.from('raw')
    this.encrypted = false
    this.decryptedRaw = Buffer.from('decrypted')
    this.downloadCalls = 0
    this.decryptCalls = 0
    this.listBackupsError = null
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    get: (key: string) => mocks.config.get(key) ?? null,
    set: (key: string, value: string) => {
      mocks.config.set(key, value)
    }
  }
}))

vi.mock('../src/main/db/repositories/kb-doc.repo', () => ({
  kbDocRepo: {
    listAll: () => mocks.docs,
    setStatus: (id: string, status: string, error?: string | null) => {
      mocks.statusCalls.push({ id, status, error })
    }
  }
}))

vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PENC1:',
  loadWebDAVConfig: () => mocks.webdavCfg,
  toCreds: (cfg: unknown) => ({ cfg }),
  listWebDAVBackups: async () => {
    if (mocks.listBackupsError) throw mocks.listBackupsError
    return mocks.backups
  },
  isEncryptedBlob: () => mocks.encrypted,
  decryptBackup: () => {
    mocks.decryptCalls++
    return mocks.decryptedRaw
  }
}))

vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: async () => {
    mocks.downloadCalls++
    return mocks.downloadRaw
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

beforeEach(() => mocks.reset())

afterEach(() => {
  stopTaskScheduler()
  vi.useRealTimers()
})

// ---------- tick 调度判定 ----------

describe('tick 到点判定', () => {
  it('从未运行：两个任务都补跑，并各写 last_run_at', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-full-20260927.zip' }]
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    expect(Number(mocks.config.get('task.kb_health_check.last_run_at'))).toBeGreaterThan(0)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(0)
  })

  it('未到点（6h 间隔，5h 前跑过）→ kb 健康检查不重跑；到点的 backup_verify 照常', async () => {
    const now = Date.now()
    mocks.config.set('task.kb_health_check.last_run_at', String(now - 5 * 3600 * 1000))
    mocks.webdavCfg = { host: 'dav.example.com' }
    await tick()
    // kb 健康检查 5h 前 < 6h 间隔 → listAll 未被调用（setStatus 也为空即未进入任务体）
    // 用 config 里 last_run_at 未被刷新验证未重跑
    expect(Number(mocks.config.get('task.kb_health_check.last_run_at')))
      .toBe(now - 5 * 3600 * 1000)
    // backup_verify 无记录 → 补跑
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(0)
  })

  it('到点（7h 前跑过 ≥ 6h 间隔）→ 重跑并刷新 last_run_at', async () => {
    const before = Date.now()
    mocks.config.set('task.kb_health_check.last_run_at', String(before - 7 * 3600 * 1000))
    await tick()
    const ts = Number(mocks.config.get('task.kb_health_check.last_run_at'))
    expect(ts).toBeGreaterThanOrEqual(before)
  })

  it('任务抛错不传播：listWebDAVBackups reject → tick 正常返回且不写该任务 last_run_at 之外的影响', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.listBackupsError = new Error('WebDAV 连不上')
    await expect(tick()).resolves.toBeUndefined()
    // kb 健康检查不受影响，正常补跑完成
    expect(Number(mocks.config.get('task.kb_health_check.last_run_at'))).toBeGreaterThan(0)
  })
})

// ---------- kb_health_check 任务体 ----------

describe('kb_health_check 卡住文档修复', () => {
  const HOUR = 3600 * 1000

  async function runKbTask(): Promise<void> {
    await tick()
  }

  it('无文档：无 setStatus 调用，任务正常完成', async () => {
    mocks.docs = []
    await runKbTask()
    expect(mocks.statusCalls).toEqual([])
  })

  it('pending 超 1 小时：标记 error 并带原因文案', async () => {
    mocks.docs = [{ id: 'd1', status: 'pending', createdAt: Date.now() - 2 * HOUR }]
    await runKbTask()
    expect(mocks.statusCalls).toEqual([
      { id: 'd1', status: 'error', error: '索引超时，已自动标记为失败' }
    ])
  })

  it('parsing / indexing 超 1 小时同样标记', async () => {
    mocks.docs = [
      { id: 'd2', status: 'parsing', createdAt: Date.now() - 2 * HOUR },
      { id: 'd3', status: 'indexing', createdAt: Date.now() - 2 * HOUR }
    ]
    await runKbTask()
    expect(mocks.statusCalls.map((c) => c.id).sort()).toEqual(['d2', 'd3'])
    expect(mocks.statusCalls.every((c) => c.status === 'error')).toBe(true)
  })

  it('卡状态但未满 1 小时：不标记', async () => {
    mocks.docs = [{ id: 'd4', status: 'pending', createdAt: Date.now() - 30 * 60 * 1000 }]
    await runKbTask()
    expect(mocks.statusCalls).toEqual([])
  })

  it('已完结状态（done/error）即使很旧也不动', async () => {
    mocks.docs = [
      { id: 'd5', status: 'done', createdAt: Date.now() - 10 * HOUR },
      { id: 'd6', status: 'error', createdAt: Date.now() - 10 * HOUR }
    ]
    await runKbTask()
    expect(mocks.statusCalls).toEqual([])
  })
})

// ---------- backup_verify 任务体 ----------

describe('backup_verify 备份校验', () => {
  it('无 WebDAV 配置：不下载不校验', async () => {
    mocks.webdavCfg = null
    await tick()
    expect(mocks.downloadCalls).toBe(0)
  })

  it('备份列表为空：不下载不校验', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = []
    await tick()
    expect(mocks.downloadCalls).toBe(0)
  })

  it('全量 zip（未加密）：下载后走 sha256 校验路径，任务正常完成', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-full-20260927.zip' }]
    mocks.downloadRaw = Buffer.from('zip content')
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    expect(mocks.decryptCalls).toBe(0)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(0)
  })

  it('加密备份：先解密再校验', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-full-20260927.zip' }]
    mocks.encrypted = true
    mocks.decryptedRaw = Buffer.from('plain zip')
    await tick()
    expect(mocks.decryptCalls).toBe(1)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(0)
  })

  it('增量备份索引有效（含 kind 与 db.sha256）：校验通过', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-inc-20260927.json' }]
    mocks.downloadRaw = Buffer.from(JSON.stringify({ kind: 'inc', db: { sha256: 'abc' } }))
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(0)
  })

  it('增量备份索引无效（缺 db.sha256）：抛错被 runTask 捕获，tick 不传播', async () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-inc-20260927.json' }]
    mocks.downloadRaw = Buffer.from(JSON.stringify({ kind: 'inc' }))
    await expect(tick()).resolves.toBeUndefined()
  })
})

// ---------- init / stop 调度周期 ----------

describe('initTaskScheduler / stopTaskScheduler 调度周期', () => {
  it('init 后 60s 触发首次 tick（补跑两任务），之后 10min 周期到点才重跑', async () => {
    vi.useFakeTimers()
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-full-20260927.zip' }]
    initTaskScheduler()
    // 未到 60s：不执行
    await vi.advanceTimersByTimeAsync(59_000)
    expect(mocks.downloadCalls).toBe(0)
    // 满 60s：首次 tick，两任务补跑
    await vi.advanceTimersByTimeAsync(1_000)
    expect(mocks.downloadCalls).toBe(1)
    const kbTs = Number(mocks.config.get('task.kb_health_check.last_run_at'))
    expect(kbTs).toBeGreaterThan(0)
    // 再推进 10 分钟：lastRun 刚刷新（fake timers 下 Date.now 同步推进），未到 6h → 不重跑
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    expect(mocks.downloadCalls).toBe(1)
    // 回填 last_run_at 为 7h 前 → 下个 tick 重跑 kb 任务
    const backfilled = Number(mocks.config.get('task.kb_health_check.last_run_at'))
    mocks.config.set('task.kb_health_check.last_run_at', String(Date.now() - 7 * 3600 * 1000))
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    // kb 重跑后 last_run_at 刷新（晚于回填值）
    expect(Number(mocks.config.get('task.kb_health_check.last_run_at')))
      .toBeGreaterThan(backfilled)
  })

  it('重复 init 不重复注册 timer；stop 后不再触发，再 init 才重新注册', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    initTaskScheduler()
    initTaskScheduler()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    // stop 后推进时间不触发
    stopTaskScheduler()
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.backups = [{ name: 'pocketai-full-20260927.zip' }]
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(mocks.downloadCalls).toBe(0)
    // 再 init：重新注册 setTimeout + setInterval
    initTaskScheduler()
    expect(setTimeoutSpy).toHaveBeenCalledTimes(2)
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(mocks.downloadCalls).toBe(1)
  })
})
