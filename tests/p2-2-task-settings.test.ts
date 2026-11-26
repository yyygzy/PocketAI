// P2-2：内置维护任务对用户开放「开关 + 间隔」。
//
// 这一批钉住四件事：
// 1. 目录是闭集：只列 kb_health_check / backup_verify，陌生 key 拒绝；读目录本身不写库
//    （否则锁屏/升级时一读就把默认值落成显式值，还把「从没配过」变成「配过」）。
// 2. 开关与间隔落 app_config，读完能原样读回；间隔只收 1–720 的整数小时，非法值不落库。
// 3. 关掉的任务在 tick 里被挡下：不跑、不刷新 last_run_at。
// 4. 补跑只补最近一次：错过多轮（模拟应用一直没开）后，一轮 tick 每个任务最多跑一次，
//    紧接着的后续 tick 不再接着补——不许开机瞬间发起一串。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  tick,
  isTaskDue,
  listTaskSchedules,
  updateTaskSchedule,
  TASK_INTERVAL_MAX_HOURS,
  TASK_INTERVAL_MIN_HOURS
} from '../src/main/backup/task-scheduler'

const mocks = vi.hoisted(() => ({
  config: new Map<string, string>(),
  docs: [] as Array<{ id: string; status: string; createdAt: number }>,
  webdavCfg: null as unknown,
  backups: [] as Array<{ name: string; mtime: number }>,
  downloadRaw: Buffer.from('zip'),
  downloadCalls: 0,
  downloadNames: [] as string[],
  dbOpen: true,
  warns: [] as string[],
  reset() {
    this.config.clear()
    this.docs = []
    this.webdavCfg = null
    this.backups = []
    this.downloadRaw = Buffer.from('zip')
    this.downloadCalls = 0
    this.downloadNames = []
    this.dbOpen = true
    this.warns = []
  }
}))

vi.mock('../src/main/db/database', () => ({
  dbService: { isOpen: () => mocks.dbOpen }
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
    setStatus: () => {}
  }
}))

vi.mock('../src/main/backup/backup-service', () => ({
  ENC_PREFIX: 'PENC1:',
  loadWebDAVConfig: () => mocks.webdavCfg,
  readWebDAVConfig: () => ({ cfg: mocks.webdavCfg, passwordUndecryptable: false, configUnreadable: false }),
  toCreds: (cfg: unknown) => ({ cfg }),
  listWebDAVBackups: async () => mocks.backups,
  isEncryptedBlob: () => false,
  decryptBackup: () => Buffer.from('plain')
}))

vi.mock('../src/main/backup/webdav-client', () => ({
  downloadFile: async (_creds: unknown, name: string) => {
    mocks.downloadCalls++
    mocks.downloadNames.push(name)
    return mocks.downloadRaw
  }
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: (...args: unknown[]) => {
      mocks.warns.push(args.map(String).join(' '))
    },
    debug: () => {},
    error: () => {}
  })
}))

const HOUR = 3600 * 1000
const dated = (name: string, day: number): { name: string; mtime: number } => ({ name, mtime: Date.UTC(2026, 8, day) })

beforeEach(() => {
  mocks.reset()
  // 备份校验这一支要真跑起来才看得见「跑没跑」：给它配一份能校验的全量包
  mocks.webdavCfg = { host: 'dav.example.com' }
  mocks.backups = [dated('pocketai-full-20260927.zip', 27)]
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------- 目录与默认值 ----------

describe('内置任务目录', () => {
  it('只列内置闭集任务，默认开着、间隔取目录默认值（kb 6h／备份校验 24h／源文件检测 6h）', () => {
    const list = listTaskSchedules()
    expect(list.map((s) => s.key)).toEqual(['kb_health_check', 'backup_verify', 'kb_source_sync'])
    expect(list.map((s) => s.intervalHours)).toEqual([6, 24, 6])
    expect(list.every((s) => s.enabled)).toBe(true)
    expect(list.every((s) => s.lastRunAt === null && s.lastOk === null)).toBe(true)
  })

  it('读目录不写库：缺省值只活在返回值里，不把「没配过」变成「配过」', () => {
    listTaskSchedules()
    expect(mocks.config.size).toBe(0)
  })

  it('目录外 key 一律拒绝（闭集，不接受用户自建任务）', () => {
    const r = updateTaskSchedule('my_custom_task', { intervalHours: 6 })
    expect(r).toEqual({ ok: false, code: 'UNKNOWN_TASK', error: expect.stringContaining('my_custom_task') })
    expect(mocks.config.size).toBe(0)
  })
})

// ---------- 开关与间隔落库 ----------

describe('开关与间隔', () => {
  it('改完立刻能读回：关闭 + 3 小时间隔都落在 app_config 里', () => {
    const r = updateTaskSchedule('backup_verify', { enabled: false, intervalHours: 3 })
    expect(r.ok).toBe(true)
    expect(mocks.config.get('task.backup_verify.enabled')).toBe('0')
    expect(mocks.config.get('task.backup_verify.interval_hours')).toBe('3')

    const read = listTaskSchedules().find((s) => s.key === 'backup_verify')!
    expect(read.enabled).toBe(false)
    expect(read.intervalHours).toBe(3)
    // 另一条任务不受影响
    const kb = listTaskSchedules().find((s) => s.key === 'kb_health_check')!
    expect(kb.enabled).toBe(true)
    expect(kb.intervalHours).toBe(6)
  })

  it('重新打开：enabled 写回 1，间隔保持用户设的值（不见回默认）', () => {
    updateTaskSchedule('kb_health_check', { enabled: false, intervalHours: 12 })
    updateTaskSchedule('kb_health_check', { enabled: true })
    const s = listTaskSchedules().find((x) => x.key === 'kb_health_check')!
    expect(s.enabled).toBe(true)
    expect(s.intervalHours).toBe(12)
  })

  it.each([
    ['0', 0],
    ['负数', -1],
    ['小数', 1.5],
    ['超上限', TASK_INTERVAL_MAX_HOURS + 1],
    ['NaN', NaN]
  ])('非法间隔被拒且不落库：%s', (_label, value) => {
    const r = updateTaskSchedule('kb_health_check', { intervalHours: value })
    expect(r).toMatchObject({ ok: false, code: 'INVALID_INTERVAL' })
    expect(mocks.config.has('task.kb_health_check.interval_hours')).toBe(false)
  })

  it('边界值本身合法：1 与 720 都收', () => {
    expect(updateTaskSchedule('kb_health_check', { intervalHours: TASK_INTERVAL_MIN_HOURS }).ok).toBe(true)
    expect(updateTaskSchedule('backup_verify', { intervalHours: TASK_INTERVAL_MAX_HOURS }).ok).toBe(true)
  })

  it('手改坏的间隔读回时退回目录默认值（0 会让它每个 tick 都「到点」）', () => {
    mocks.config.set('task.kb_health_check.interval_hours', '0')
    mocks.config.set('task.backup_verify.interval_hours', 'abc')
    const list = listTaskSchedules()
    expect(list.map((s) => s.intervalHours)).toEqual([6, 24, 6])
  })
})

// ---------- 开关在 tick 里真的生效 ----------

describe('关掉的任务不跑', () => {
  it('两条都关掉：tick 一次也不跑，连 last_run_at 都不写（关着不算「跑过」）', async () => {
    updateTaskSchedule('kb_health_check', { enabled: false })
    updateTaskSchedule('backup_verify', { enabled: false })

    await tick()

    expect(mocks.downloadCalls).toBe(0)
    expect(mocks.config.has('task.kb_health_check.last_run_at')).toBe(false)
    expect(mocks.config.has('task.backup_verify.last_run_at')).toBe(false)
  })

  it('反向对照：打开的任务在同一轮 tick 里照跑（开关不是把所有任务一起停掉）', async () => {
    updateTaskSchedule('kb_health_check', { enabled: false })
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    expect(mocks.config.get('task.backup_verify.last_run_at')).toBeTruthy()
    expect(mocks.config.get('task.kb_health_check.last_run_at')).toBeUndefined()
  })
})

// ---------- 间隔在 tick 里真的生效 ----------

describe('自定义间隔', () => {
  it('设成 1 小时：30 分钟前跑过 → 不到点，不跑', async () => {
    updateTaskSchedule('backup_verify', { intervalHours: 1 })
    mocks.config.set('task.backup_verify.last_run_at', String(Date.now() - 30 * 60 * 1000))
    await tick()
    expect(mocks.downloadCalls).toBe(0)
  })

  it('设成 1 小时：61 分钟前跑过 → 到点，跑一次', async () => {
    updateTaskSchedule('backup_verify', { intervalHours: 1 })
    mocks.config.set('task.backup_verify.last_run_at', String(Date.now() - 61 * 60 * 1000))
    await tick()
    expect(mocks.downloadCalls).toBe(1)
  })

  it('间隔调大就真的变慢：kb 默认 6h 下 7 小时前跑过会跑；改成 24h 后同样 7 小时前就不跑了', async () => {
    const sevenHoursAgo = Date.now() - 7 * HOUR
    mocks.config.set('task.kb_health_check.last_run_at', String(sevenHoursAgo))
    await tick()
    expect(Number(mocks.config.get('task.kb_health_check.last_run_at'))).toBeGreaterThan(sevenHoursAgo)

    // 改成 24h 后，同样 7 小时前跑过就不到点了
    updateTaskSchedule('kb_health_check', { intervalHours: 24 })
    const backfilled = Date.now() - 7 * HOUR
    mocks.config.set('task.kb_health_check.last_run_at', String(backfilled))
    await tick()
    expect(mocks.config.get('task.kb_health_check.last_run_at')).toBe(String(backfilled))
  })
})

// ---------- 补跑只补一次 ----------

describe('错过多轮只补跑一次', () => {
  it('错过 3 天（间隔 1h）：一轮 tick 只跑一次，紧接着再 tick 三次也不接着补', async () => {
    updateTaskSchedule('backup_verify', { intervalHours: 1 })
    const longAgo = Date.now() - 72 * HOUR
    mocks.config.set('task.backup_verify.last_run_at', String(longAgo))

    await tick()
    expect(mocks.downloadCalls).toBe(1)
    const refreshed = Number(mocks.config.get('task.backup_verify.last_run_at'))
    expect(refreshed).toBeGreaterThan(longAgo)

    // 随后连跑三轮（模拟启动后头半小时内的 tick）：一次都不许再补
    await tick()
    await tick()
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBe(refreshed)
  })

  it('从未跑过（last_run_at 缺）也算「只补一次」：首轮跑完即有账，第二轮不再跑', async () => {
    updateTaskSchedule('backup_verify', { intervalHours: 1 })
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    await tick()
    expect(mocks.downloadCalls).toBe(1)
  })
})

// ---------- 重新启用＝从现在起算 ----------

describe('重新启用不从旧账起算', () => {
  it('关切再打开后立刻 tick 不执行；到期后才执行（这一条在「只看 last_run_at」的旧实现下必红）', async () => {
    // 先跑成一次，再关掉——关闭期间 last_run_at 停在老时间
    updateTaskSchedule('backup_verify', { intervalHours: 1 })
    await tick()
    expect(mocks.downloadCalls).toBe(1)
    const ranAt = Number(mocks.config.get('task.backup_verify.last_run_at'))
    expect(ranAt).toBeGreaterThan(0)

    updateTaskSchedule('backup_verify', { enabled: false })
    expect(mocks.config.get('task.backup_verify.enabled_at')).toBeUndefined()

    // 模拟「关了 5 天」：旧账停在 5 天前，然后用户重新打开
    const stale = Date.now() - 120 * HOUR
    mocks.config.set('task.backup_verify.last_run_at', String(stale))
    updateTaskSchedule('backup_verify', { enabled: true })
    const enabledAt = Number(mocks.config.get('task.backup_verify.enabled_at'))
    expect(enabledAt).toBeGreaterThan(0)
    // 启用不写 last_run_at：那颗键只记「真的跑过」，否则面板会把刚开开关显示成上次执行
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBe(stale)

    // 立刻 tick：锚点是现在，1 小时档还差得远 ⇒ 不跑
    await tick()
    expect(mocks.downloadCalls).toBe(1)

    // 差一分钟到期：仍不跑
    mocks.config.set('task.backup_verify.enabled_at', String(Date.now() - HOUR + 60 * 1000))
    await tick()
    expect(mocks.downloadCalls).toBe(1)

    // 刚好到期：才跑这一发
    mocks.config.set('task.backup_verify.enabled_at', String(Date.now() - HOUR - 1000))
    await tick()
    expect(mocks.downloadCalls).toBe(2)
    expect(Number(mocks.config.get('task.backup_verify.last_run_at'))).toBeGreaterThan(Date.now() - 5 * 60 * 1000)
  })

  it('关→开→关→开：只认最后一次开启时刻（中途那次的锚点不作数）', async () => {
    updateTaskSchedule('backup_verify', { intervalHours: 1 })
    updateTaskSchedule('backup_verify', { enabled: false })
    // 第一次开启：把锚点手改到「早就到期」，制造一个诱饵
    updateTaskSchedule('backup_verify', { enabled: true })
    mocks.config.set('task.backup_verify.enabled_at', String(Date.now() - 48 * HOUR))

    // 再关再开：锚点必须刷成现在
    updateTaskSchedule('backup_verify', { enabled: false })
    updateTaskSchedule('backup_verify', { enabled: true })
    const enabledAt = Number(mocks.config.get('task.backup_verify.enabled_at'))
    expect(enabledAt).toBeGreaterThan(Date.now() - 60 * 1000)

    await tick()
    expect(mocks.downloadCalls).toBe(0)
  })

  it('开着的任务只改间隔：不动启用锚点（改个间隔不该把「从现在起算」又推一遍）', () => {
    updateTaskSchedule('backup_verify', { enabled: false })
    updateTaskSchedule('backup_verify', { enabled: true })
    const anchor = mocks.config.get('task.backup_verify.enabled_at')

    updateTaskSchedule('backup_verify', { intervalHours: 12 })
    expect(mocks.config.get('task.backup_verify.enabled_at')).toBe(anchor)
  })
})

// ---------- isTaskDue 纯函数边界 ----------

describe('isTaskDue 判据', () => {
  const now = 10 * 24 * HOUR

  it('关掉一律不到点（哪怕从未跑过）', () => {
    expect(isTaskDue({ enabled: false, intervalHours: 1, lastRunAt: null }, now)).toBe(false)
    expect(isTaskDue({ enabled: false, intervalHours: 1, lastRunAt: now - 999 * HOUR }, now)).toBe(false)
  })

  it('从未跑过 → 到点', () => {
    expect(isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: null }, now)).toBe(true)
  })

  it('恰好等于间隔算到点（与旧实现的 >= 同口径）', () => {
    expect(isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: now - 6 * HOUR }, now)).toBe(true)
    expect(isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: now - 6 * HOUR + 1 }, now)).toBe(false)
  })

  it('启用锚点比旧账新时以锚点为准：旧账 5 天前也不到点', () => {
    expect(
      isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: now - 120 * HOUR, enabledAt: now - 1 * HOUR }, now)
    ).toBe(false)
    expect(
      isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: now - 120 * HOUR, enabledAt: now - 6 * HOUR }, now)
    ).toBe(true)
  })

  it('真的跑过之后（last_run_at 新于启用锚点）回到按 last_run_at 判', () => {
    expect(
      isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: now - 1 * HOUR, enabledAt: now - 48 * HOUR }, now)
    ).toBe(false)
    expect(
      isTaskDue({ enabled: true, intervalHours: 6, lastRunAt: now - 7 * HOUR, enabledAt: now - 48 * HOUR }, now)
    ).toBe(true)
  })
})
