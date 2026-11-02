// steward/diagnose 安全检测与故障诊断测试
//
// 覆盖 src/main/steward/diagnose.ts 的核心路径：
// - levelScore / scoreOf 纯函数评分
// - runAudit：加密 / 锁屏 / 自动锁 / 完整性 / 备份 / 便携风险 6 项
// - runDiagnose：完整性 / 孤儿消息 / 孤儿向量块 / 迁移版本 / 目录可写 / DB 文件 / 磁盘 / Provider 8 项
// - safeItem 容错：单项异常返回 danger 不阻塞整份报告
//
// 策略：
// - vi.mock 8 个外部依赖（dbService / masterKeyManager / appConfigRepo / providerRepo / backup-service / backup-scheduler / hardware / node:fs / portable）
// - vi.hoisted 集中 mocks 状态，每用例 reset 后注入场景
// - 纯函数 levelScore / scoreOf 直接 import 断言
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { SecurityCheck, DiagnoseItem, ProviderRecord } from '../src/shared/types'
import { levelScore, scoreOf, runAudit, runDiagnose } from '../src/main/steward/diagnose'

// ---------- mock 工厂 ----------

const mocks = vi.hoisted(() => ({
  // 加密 / 锁
  dbMode: 'none' as string,
  unlocked: false,
  autoLockTimeout: 0,
  // DB 查询结果
  integrity: 'ok' as string,
  orphanMessages: 0,
  orphanChunks: 0,
  schemaVersion: 99 as number | null,
  dbError: null as Error | null, // 不为 null 时所有 prepare().get() 抛错
  // 备份
  webdavCfg: null as unknown,
  webdavCfgBroken: false,
  webdavPwdBroken: false,
  schedule: { enabled: false, intervalHours: 6, lastResult: null as null | { ok: boolean; at: number }, lastOkAt: null as number | null },
  backupError: null as Error | null,
  // 硬件
  hwDiskRemovable: false,
  hwDiskFreeSpace: null as number | null,
  hwError: null as Error | null,
  // Provider
  providers: [] as ProviderRecord[],
  // fs
  dbFileExists: true,
  writeOk: true,
  reset() {
    this.dbMode = 'none'
    this.unlocked = false
    this.autoLockTimeout = 0
    this.integrity = 'ok'
    this.orphanMessages = 0
    this.orphanChunks = 0
    this.schemaVersion = 99
    this.dbError = null
    this.webdavCfg = null
    this.webdavCfgBroken = false
    this.webdavPwdBroken = false
    this.schedule = { enabled: false, intervalHours: 6, lastResult: null, lastOkAt: null }
    this.backupError = null
    this.hwDiskRemovable = false
    this.hwDiskFreeSpace = null
    this.hwError = null
    this.providers = []
    this.dbFileExists = true
    this.writeOk = true
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: {
    getHandle: () => ({
      prepare: (sql: string) => ({
        get: () => {
          if (mocks.dbError) throw mocks.dbError
          const s = sql.replace(/\s+/g, ' ').trim()
          if (s.startsWith('PRAGMA integrity_check')) return { 'integrity_check': mocks.integrity }
          if (s.includes('FROM messages m')) return { c: mocks.orphanMessages }
          if (s.includes('FROM kb_chunks kc')) return { c: mocks.orphanChunks }
          if (s.includes('FROM schema_migrations')) return { v: mocks.schemaVersion }
          return null
        }
      })
    })
  },
  LATEST_SCHEMA_VERSION: 99
}))

vi.mock('../src/main/crypto/master-key', () => ({
  masterKeyManager: {
    getMode: () => mocks.dbMode,
    hasKey: () => mocks.unlocked
  }
}))

vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: {
    getAutoLockTimeout: () => mocks.autoLockTimeout
  }
}))

vi.mock('../src/main/db/repositories/provider.repo', () => ({
  providerRepo: {
    list: () => mocks.providers.slice()
  }
}))

vi.mock('../src/main/backup/backup-service', () => ({
  loadWebDAVConfig: () => {
    if (mocks.backupError) throw mocks.backupError
    return mocks.webdavCfg
  },
  // §382：体检这一读换成 readWebDAVConfig（`!!load` 把"口令解不开"画成「已配置…level:ok」）
  readWebDAVConfig: () => {
    if (mocks.backupError) throw mocks.backupError
    return {
      cfg: mocks.webdavCfg,
      passwordUndecryptable: mocks.webdavPwdBroken,
      // §386：第三颗＝那一行存在却解析不出来；桩缺它＝真源码读到 undefined
      configUnreadable: mocks.webdavCfgBroken
    }
  }
}))

vi.mock('../src/main/backup/backup-scheduler', () => ({
  getBackupSchedule: () => mocks.schedule
}))

vi.mock('../src/main/steward/hardware', () => ({
  getHardwareInfo: () => {
    if (mocks.hwError) throw mocks.hwError
    return {
      cpu: { model: 'x', cores: 1 },
      memory: { total: 0, free: 0 },
      gpus: [],
      disk: {
        type: 'unknown' as const,
        removable: mocks.hwDiskRemovable,
        drive: null,
        volumeLabel: null,
        filesystem: null,
        totalSpace: null,
        freeSpace: mocks.hwDiskFreeSpace,
        mediumType: null,
        busType: null
      },
      os: { platform: 'test', release: '0', arch: 'x64' }
    }
  }
}))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: '/tmp/pocketai-data',
  DB_PATH: '/tmp/pocketai-data/pocketai.db'
}))

vi.mock('node:fs', () => ({
  existsSync: (p: string) => (p === '/tmp/pocketai-data/pocketai.db' ? mocks.dbFileExists : false),
  unlinkSync: () => {},
  writeFileSync: () => {
    if (!mocks.writeOk) throw new Error('disk full')
  }
}))

// ---------- 辅助 ----------

function findAudit(checks: SecurityCheck[], id: string): SecurityCheck | undefined {
  return checks.find((c) => c.id === id)
}
function findItem(items: DiagnoseItem[], id: string): DiagnoseItem | undefined {
  return items.find((i) => i.id === id)
}

beforeEach(() => mocks.reset())

// ---------- 纯函数 ----------

describe('levelScore 纯函数', () => {
  it('danger 扣 30', () => {
    expect(levelScore('danger')).toBe(30)
  })
  it('warn 扣 10', () => {
    expect(levelScore('warn')).toBe(10)
  })
  it('ok 扣 0', () => {
    expect(levelScore('ok')).toBe(0)
  })
})

describe('scoreOf 纯函数', () => {
  it('空数组得 100', () => {
    expect(scoreOf([])).toBe(100)
  })
  it('单个 danger 得 70', () => {
    expect(scoreOf([{ id: 'x', label: 'x', level: 'danger', detail: 'x' }])).toBe(70)
  })
  it('多项扣分下界为 0 不为负', () => {
    const checks: SecurityCheck[] = [
      { id: 'a', label: 'a', level: 'danger', detail: 'a' },
      { id: 'b', label: 'b', level: 'danger', detail: 'b' },
      { id: 'c', label: 'c', level: 'danger', detail: 'c' },
      { id: 'd', label: 'd', level: 'danger', detail: 'd' }
    ]
    // 4 * 30 = 120，max(0, 100-120) = 0
    expect(scoreOf(checks)).toBe(0)
  })
})

// ---------- runAudit ----------

describe('runAudit 安全检测', () => {
  it('dbMode=none：仅 db-encryption warn，无 lock-state / auto-lock', () => {
    mocks.dbMode = 'none'
    const r = runAudit()
    expect(findAudit(r.checks, 'db-encryption')?.level).toBe('warn')
    expect(findAudit(r.checks, 'lock-state')).toBeUndefined()
    expect(findAudit(r.checks, 'auto-lock')).toBeUndefined()
  })

  // 以下 dbMode=db 用例均设置完整 backup，让 score 只反映被测项
  function setupBackupOk() {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.schedule = {
      enabled: true,
      intervalHours: 6,
      lastOkAt: Date.now() - 1 * 24 * 3600 * 1000,
      lastResult: { ok: true, at: Date.now() - 1 * 24 * 3600 * 1000 }
    }
  }

  it('dbMode=db + unlocked + autoLock>0：三项全 ok，score=100', () => {
    mocks.dbMode = 'db'
    mocks.unlocked = true
    mocks.autoLockTimeout = 5 * 60000
    setupBackupOk()
    const r = runAudit()
    expect(findAudit(r.checks, 'db-encryption')?.level).toBe('ok')
    expect(findAudit(r.checks, 'lock-state')?.level).toBe('ok')
    expect(findAudit(r.checks, 'auto-lock')?.level).toBe('ok')
    expect(r.score).toBe(100)
  })

  it('dbMode=db + locked：lock-state danger，扣 30 分', () => {
    mocks.dbMode = 'db'
    mocks.unlocked = false
    mocks.autoLockTimeout = 5 * 60000
    setupBackupOk()
    const r = runAudit()
    const lock = findAudit(r.checks, 'lock-state')
    expect(lock?.level).toBe('danger')
    expect(lock?.suggestion).toBeTruthy()
    expect(r.score).toBe(70)
  })

  it('dbMode=db + autoLock=0：auto-lock warn，扣 10 分', () => {
    mocks.dbMode = 'db'
    mocks.unlocked = true
    mocks.autoLockTimeout = 0
    setupBackupOk()
    const r = runAudit()
    expect(findAudit(r.checks, 'auto-lock')?.level).toBe('warn')
    expect(r.score).toBe(90)
  })

  it('integrity ok：level ok', () => {
    mocks.integrity = 'ok'
    const r = runAudit()
    expect(findAudit(r.checks, 'integrity')?.level).toBe('ok')
  })

  it('integrity 非 ok：level danger + suggestion', () => {
    mocks.integrity = 'error: database disk image is malformed'
    const r = runAudit()
    const item = findAudit(r.checks, 'integrity')
    expect(item?.level).toBe('danger')
    expect(item?.detail).toContain('error: database disk image is malformed')
    expect(item?.suggestion).toBeTruthy()
  })

  it('integrity 查询抛异常：返回 danger + 错误信息', () => {
    mocks.dbError = new Error('database is locked')
    const r = runAudit()
    const item = findAudit(r.checks, 'integrity')
    expect(item?.level).toBe('danger')
    expect(item?.detail).toContain('database is locked')
  })

  it('backup 无 WebDAV 配置：backup-cloud warn，无 backup-freshness', () => {
    mocks.webdavCfg = null
    const r = runAudit()
    expect(findAudit(r.checks, 'backup-cloud')?.level).toBe('warn')
    expect(findAudit(r.checks, 'backup-freshness')).toBeUndefined()
  })

  it('backup 有 cfg + schedule.enabled + 近期成功：backup-cloud ok + backup-freshness ok', () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.schedule = {
      enabled: true,
      intervalHours: 6,
      lastOkAt: Date.now() - 1 * 24 * 3600 * 1000,
      lastResult: { ok: true, at: Date.now() - 1 * 24 * 3600 * 1000 }
    }
    const r = runAudit()
    expect(findAudit(r.checks, 'backup-cloud')?.level).toBe('ok')
    expect(findAudit(r.checks, 'backup-freshness')?.level).toBe('ok')
  })

  // §382：`!!loadWebDAVConfig()` 在"口令有密文却解不开"那一档读到 true ⇒ 改前这里走的是上面那条
  // ok 支（「WebDAV 已配置，定时备份每 6 小时执行」），而那份口令下一次鉴权必失败。
  it('§382 口令解不开＋定时开着：第三张脸（warn＋"解不开"那句），不许再说「每 6 小时执行」', () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.webdavPwdBroken = true
    mocks.schedule = { enabled: true, intervalHours: 6, lastOkAt: Date.now() - 3600 * 1000, lastResult: { ok: true, at: Date.now() - 3600 * 1000 } }
    const item = findAudit(runAudit().checks, 'backup-cloud')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('解不开')
    expect(item?.detail).not.toContain('每 6 小时执行')
    expect(item?.suggestion).toContain('设置 → 备份')
  })

  // §386：那一行**存在却解析不出来**（整库恢复把 app_config 整表换成坏行）原先与「没配过」共用出口，
  // 这一格说「未配置 WebDAV」＝把用户支去填一份新配置，而那份坏行就此被覆盖掉。
  it('§386 那一行读不出来：danger＋说"读不出来"，不许说「未配置 WebDAV」', () => {
    mocks.webdavCfgBroken = true
    const item = findAudit(runAudit().checks, 'backup-cloud')
    expect(item?.level).toBe('danger')
    expect(item?.detail).toContain('读不出来')
    expect(item?.detail, '这一档与"没配过"是两件事').not.toContain('未配置 WebDAV')
    expect(item?.suggestion).toContain('设置 → 备份')
  })

  it('§386 反向对照：真没配过（那颗 false）⇒ 仍是原来那句 warn「未配置 WebDAV」', () => {
    mocks.webdavCfg = null
    mocks.webdavCfgBroken = false
    const item = findAudit(runAudit().checks, 'backup-cloud')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('未配置 WebDAV')
  })

  it('§382 口令解不开＋定时没开：同一张脸（不把"定时未开启"当成原因）', () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.webdavPwdBroken = true
    const item = findAudit(runAudit().checks, 'backup-cloud')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('解不开')
    expect(item?.detail).not.toContain('定时备份未开启')
  })

  it('§382 反向对照：解不开那一档不再推 backup-freshness（第三张脸已经比它更重，不摆两句相互矛盾的话）', () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.webdavPwdBroken = true
    mocks.schedule = { enabled: true, intervalHours: 6, lastOkAt: Date.now() - 40 * 24 * 3600 * 1000, lastResult: { ok: true, at: Date.now() - 40 * 24 * 3600 * 1000 } }
    expect(findAudit(runAudit().checks, 'backup-freshness')).toBeUndefined()
  })

  it('§382 正向对照：那颗为 false 时那一格照常（新判据不许把正常档也拉成 warn）', () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.webdavPwdBroken = false
    mocks.schedule = { enabled: true, intervalHours: 6, lastOkAt: Date.now() - 3600 * 1000, lastResult: { ok: true, at: Date.now() - 3600 * 1000 } }
    const item = findAudit(runAudit().checks, 'backup-cloud')
    expect(item?.level).toBe('ok')
    expect(item?.detail).toContain('每 6 小时执行')
  })

  it('backup 上次成功 30+ 天前：backup-freshness danger', () => {
    mocks.webdavCfg = { host: 'dav.example.com' }
    mocks.schedule = {
      enabled: true,
      intervalHours: 6,
      lastOkAt: Date.now() - 40 * 24 * 3600 * 1000,
      lastResult: { ok: true, at: Date.now() - 40 * 24 * 3600 * 1000 }
    }
    const r = runAudit()
    const fresh = findAudit(r.checks, 'backup-freshness')
    expect(fresh?.level).toBe('danger')
    expect(fresh?.suggestion).toBeTruthy()
  })

  it('backup 配置读取抛异常：backup-cloud warn 容错', () => {
    mocks.backupError = new Error('config read failed')
    const r = runAudit()
    const cloud = findAudit(r.checks, 'backup-cloud')
    expect(cloud?.level).toBe('warn')
    expect(cloud?.detail).toContain('config read failed')
  })

  it('便携介质 removable=true：portable-physical warn', () => {
    mocks.hwDiskRemovable = true
    const r = runAudit()
    expect(findAudit(r.checks, 'portable-physical')?.level).toBe('warn')
  })

  it('便携介质 removable=false：无 portable-physical 项', () => {
    mocks.hwDiskRemovable = false
    const r = runAudit()
    expect(findAudit(r.checks, 'portable-physical')).toBeUndefined()
  })
})

// ---------- runDiagnose ----------

describe('runDiagnose 故障诊断', () => {
  it('integrity ok：level ok', () => {
    mocks.integrity = 'ok'
    const r = runDiagnose()
    expect(findItem(r.items, 'integrity')?.level).toBe('ok')
  })

  it('integrity 非 ok：level danger + fix', () => {
    mocks.integrity = 'error: malformed'
    const r = runDiagnose()
    const item = findItem(r.items, 'integrity')
    expect(item?.level).toBe('danger')
    expect(item?.fix).toBeTruthy()
  })

  it('orphan-messages：c=0 ok / c>0 warn', () => {
    mocks.orphanMessages = 0
    expect(findItem(runDiagnose().items, 'orphan-messages')?.level).toBe('ok')
    mocks.orphanMessages = 3
    const item = findItem(runDiagnose().items, 'orphan-messages')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('3')
    expect(item?.fix).toBeTruthy()
  })

  it('orphan-chunks：c=0 ok / c>0 warn', () => {
    mocks.orphanChunks = 0
    expect(findItem(runDiagnose().items, 'orphan-chunks')?.level).toBe('ok')
    mocks.orphanChunks = 5
    const item = findItem(runDiagnose().items, 'orphan-chunks')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('5')
  })

  it('schema-version：current>=LATEST ok / <LATEST danger', () => {
    mocks.schemaVersion = 99
    expect(findItem(runDiagnose().items, 'schema-version')?.level).toBe('ok')
    mocks.schemaVersion = 1
    const item = findItem(runDiagnose().items, 'schema-version')
    expect(item?.level).toBe('danger')
    expect(item?.fix).toBeTruthy()
  })

  it('data-dir-writable：writeFileSync 成功 → ok', () => {
    mocks.writeOk = true
    const item = findItem(runDiagnose().items, 'data-dir-writable')
    expect(item?.level).toBe('ok')
  })

  it('data-dir-writable：writeFileSync 抛错 → danger（safeItem 容错）', () => {
    mocks.writeOk = false
    const item = findItem(runDiagnose().items, 'data-dir-writable')
    expect(item?.level).toBe('danger')
    expect(item?.detail).toContain('检测异常')
  })

  it('db-file：exists=true ok / exists=false danger', () => {
    mocks.dbFileExists = true
    expect(findItem(runDiagnose().items, 'db-file')?.level).toBe('ok')
    mocks.dbFileExists = false
    const item = findItem(runDiagnose().items, 'db-file')
    expect(item?.level).toBe('danger')
    expect(item?.fix).toBeTruthy()
  })

  it('disk-space：free=null ok / gb<2 danger / gb<5 warn / gb>=5 ok', () => {
    const GB = 1024 * 1024 * 1024
    mocks.hwDiskFreeSpace = null
    expect(findItem(runDiagnose().items, 'disk-space')?.level).toBe('ok')
    mocks.hwDiskFreeSpace = 1 * GB
    expect(findItem(runDiagnose().items, 'disk-space')?.level).toBe('danger')
    mocks.hwDiskFreeSpace = 3 * GB
    expect(findItem(runDiagnose().items, 'disk-space')?.level).toBe('warn')
    mocks.hwDiskFreeSpace = 10 * GB
    expect(findItem(runDiagnose().items, 'disk-space')?.level).toBe('ok')
  })

  it('providers：空 → warn；配置完整 → ok；缺 API Key → warn', () => {
    mocks.providers = []
    expect(findItem(runDiagnose().items, 'providers')?.level).toBe('warn')

    // 正常配置
    mocks.providers = [{
      id: 'p1', type: 'openai-compatible', name: 'OpenAI', baseUrl: 'https://api.openai.com',
      apiKeys: ['sk-xxx'], models: ['gpt-4'], enabled: true, createdAt: 0
    }]
    expect(findItem(runDiagnose().items, 'providers')?.level).toBe('ok')

    // enabled 但缺 API Key（非 ollama）
    mocks.providers = [{
      id: 'p2', type: 'openai-compatible', name: 'NoKey', baseUrl: 'https://api.openai.com',
      apiKeys: [], models: ['gpt-4'], enabled: true, createdAt: 0
    }]
    const item = findItem(runDiagnose().items, 'providers')
    expect(item?.level).toBe('warn')
    expect(item?.detail).toContain('API Key')
  })

  it('DB 查询全程抛错：涉 DB 各项 safeItem 容错返回 danger', () => {
    mocks.dbError = new Error('database is locked')
    const r = runDiagnose()
    expect(findItem(r.items, 'integrity')?.level).toBe('danger')
    expect(findItem(r.items, 'orphan-messages')?.level).toBe('danger')
    expect(findItem(r.items, 'orphan-chunks')?.level).toBe('danger')
    expect(findItem(r.items, 'schema-version')?.level).toBe('danger')
    // detail 含「检测异常」前缀
    expect(findItem(r.items, 'integrity')?.detail).toContain('检测异常')
  })
})
