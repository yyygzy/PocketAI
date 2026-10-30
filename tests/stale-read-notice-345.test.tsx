// @vitest-environment jsdom
// V4-Iter-345：「面板先读到过值、之后那一发又重读」的落点——重读失败时原因必须有出口。
//
// 缺陷形状＝§222 那一族的第三形态：`if (!数据) { if (err) return <LoadFailNotice/>; return 加载中 }`
// 的门只认"数据缺失"。首读成功后 err 再怎么写都上不了屏，于是屏上摆着一份**没人认领的旧数据**，
// 而那一屏的键照旧值可点（设置页据此能去动一个已经变明文的库）。
//
// 每处都配两条反向对照，缺一条就红：
//   A 数据缺失＋失败 ⇒ 仍是 §222 那句「读不到」（本批没动它）；
//   B 有数据＋没失败 ⇒ 一个 alert 都不许有（不许把成功的那一发说成旧值）；
// 再加一条"按了重试就真再发一发、成功后那句当场收回"。
//
// 覆盖七处：加密面板／许可证／定时备份计划（BackupPanel 上传后那一发）／数据健康（刷新键）／
// 用量汇总（切时间窗）／Ollama 运行时状态（启停后立刻再读）／管家页模型推荐（重新检测）。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { EncryptionPanel, LicensePanel, BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { DataHealthPanel } from '../src/renderer/src/modules/settings/DataHealthPanel'
import { UsagePanel } from '../src/renderer/src/modules/settings/UsagePanel'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { StewardModule } from '../src/renderer/src/modules/steward/StewardModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  DataHealthReport,
  EncryptionStatus,
  LicenseStatus,
  ModelRecommendation,
  OllamaRuntimeStatus,
  UsageAssistantItem,
  UsageConversationItem,
  UsagePricing,
  UsageSummary,
  WebDAVBackupFile
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
/** §230 那句话的成对键：点名是哪一格刷新失败，并说明屏上停在上一份 */
const STALE = (what: string, msg: string): string =>
  L('common.refreshFailedNamed').replace('{what}', what).replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const toasts = (): string[] => screen.queryAllByRole('status').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const settleAfter = async (fn: string, times = 1): Promise<void> => {
  await waitFor(() => expect(calledFns().filter((f) => f === fn).length).toBe(times))
  await settle()
}

const FAIL = { ok: false, error: '库被占用' }

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

// ───────────────────────────── ① 加密面板（props 驱动） ─────────────────────────────
const enc = (over: Partial<EncryptionStatus> = {}): EncryptionStatus =>
  ({
    mode: 'db', dbEncrypted: true, unlocked: true, masterPasswordVerified: true, recoveryKeyExists: false,
    kdfN: 131072, kdfAtCurrentTier: true, autoLockMinutes: 5, ...over
  }) as EncryptionStatus

// props 驱动的两块（加密／许可证）在数据到位后还会连带挂出自动锁、恢复密钥、指纹这些自己拉的读，
// 桩不给就是 `window.pocketai.getLockStatus is not a function`——与 §225 同一份形状。
const PANEL_STUBS = {
  getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 0 }),
  hasRecoveryKey: () => ({ has: false, carriedFrom: null }),
  getLicenseFingerprint: () => 'fp-1234'
}

describe('① 加密面板：副本还在、重读失败 ⇒ 旧值横幅＋重试', () => {
  it('有数据＋有原因 ⇒ 屏上是那一句"没能刷新成最新"，且「数据库加密」两行照旧在', () => {
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<EncryptionPanel enc={enc()} err={'库被占用'} onChange={() => {}} />)
    expect(alerts()).toEqual([STALE(L('enc.dbEnc'), '库被占用')])
    expect(screen.getByText(L('enc.dbEnc'))).toBeTruthy()
  })

  it('反向对照 A：没有数据时仍是 §222 那句「读不到」，不许换成旧值横幅（那时没有旧值）', () => {
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<EncryptionPanel enc={null} err={'库被占用'} onChange={() => {}} />)
    expect(alerts()).toEqual([FAILED('库被占用')])
  })

  it('反向对照 B：数据在、没有失败 ⇒ 一个 alert 都不许有', () => {
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
    expect(alerts()).toEqual([])
  })

  it('按「重试」＝喊父页那份副本重取（onChange 就是 useEncryptionCopy 的 refresh），不是把那句横幅自己藏起来', async () => {
    let n = 0
    stubPocketai(PANEL_STUBS)
    // props 驱动的面板自己没有那一发读：它只许调用父页交下来的重取入口
    mountWithProviders(<EncryptionPanel enc={enc()} err={'库被占用'} onChange={() => { n++ }} />)
    fireEvent.click(screen.getByTestId('enc-stale-retry'))
    await settle()
    expect(n, '那颗键必须真打到面板自己的重取入口，不然横幅只是一条能关掉的原因').toBe(1)
    expect(alerts(), '重取入口被调用不等于读数到货：这一发桩里没有新数据，那句旧值横幅必须还挂着').toEqual([
      STALE(L('enc.dbEnc'), '库被占用')
    ])
  })
})

// ───────────────────────────── ② 许可证（props 驱动） ─────────────────────────────
const lic = (): LicenseStatus =>
  ({ valid: true, payload: { owner: '墨匣用户', plan: 'pro', expires_at: Date.now() + 86400000, features: [] } }) as unknown as LicenseStatus

describe('② 许可证面板：两个读者（挂载＋激活后重拉），第二发失败要有出口', () => {
  it('有数据＋有原因 ⇒ 那一句在，且「授权状态」两行照旧', () => {
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<LicensePanel lic={lic()} err={'许可证文件损坏'} onChange={() => {}} />)
    expect(alerts()).toEqual([STALE(L('lic.status'), '许可证文件损坏')])
    expect(screen.getByText(L('lic.holder'))).toBeTruthy()
  })

  it('反向对照：数据在、没有失败 ⇒ 没有 alert（成功的那一发不许被说成旧值）', () => {
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<LicensePanel lic={lic()} err={null} onChange={() => {}} />)
    expect(alerts()).toEqual([])
  })

  it('按「重试」＝喊父页那份许可证副本重取', async () => {
    let n = 0
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<LicensePanel lic={lic()} err={'许可证文件损坏'} onChange={() => { n++ }} />)
    fireEvent.click(screen.getByTestId('lic-stale-retry'))
    await settle()
    expect(n, '那颗键必须真打到面板自己的重取入口').toBe(1)
    expect(alerts(), '重取入口被调用不等于读数到货：那句旧值横幅必须还挂着').toEqual([
      STALE(L('lic.status'), '许可证文件损坏')
    ])
  })
})

// ─────────────────────── ③ 定时备份计划（BackupPanel 上传后那一发） ───────────────────────
const SCHED = { enabled: true, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }
const CFG = { url: 'https://dav.example.com/old', username: 'me', passwordCipher: 'x', directory: '/b' }
const FILE: WebDAVBackupFile = { name: 'pocketai-full-2026-10-25.zip', size: 1024, mtime: 1, encrypted: false, kind: 'full' }

describe('③ 定时备份：doUpload 之后那一发 getBackupSchedule 失败 ⇒ 旧计划上面挂那句', () => {
  it('进面板读到计划、上传后重读失败 ⇒ 计划仍在屏上＋旧值横幅；按「重试」再发一发，成功后那句消失', async () => {
    let fail = false
    stubPocketai({
      loadWebDAVConfig: () => CFG,
      listWebDAVBackups: () => [FILE],
      uploadWebDAVBackup: () => ({ ok: true, filename: FILE.name }),
      setBackupSchedule: (p: unknown) => ({ ...SCHED, ...(p as object) }),
      saveWebDAVConfig: (c: unknown) => ({ ok: true, cfg: c }),
      testWebDAV: () => ({ ok: true }),
      getBackupSchedule: () => (fail ? FAIL : SCHED)
    })
    mountWithProviders(<BackupPanel enc={null} />)
    await settleAfter('getBackupSchedule')
    expect(alerts()).toEqual([])
    expect(screen.getByText(L('bk.scheduleEnable'))).toBeTruthy()

    fail = true
    fireEvent.click(screen.getByRole('button', { name: L('bk.uploadBtn') }))
    await waitFor(() => expect(alerts()).toEqual([STALE(L('dh.backupState'), '库被占用')]))
    expect(alerts()).toEqual([STALE(L('dh.backupState'), '库被占用')])
    // 旧计划照常在屏上（这正是危险之处：那颗开关是按旧值摆的）
    expect(screen.getByText(L('bk.scheduleEnable'))).toBeTruthy()

    fail = false
    fireEvent.click(screen.getByTestId('schedule-stale-retry'))
    await settleAfter('getBackupSchedule', 3)
    await waitFor(() => expect(alerts()).toEqual([]))
  })
})

// ───────────────────────────── ④ 数据健康（那颗「刷新」键） ─────────────────────────────
const report = (): DataHealthReport => ({
  sizes: {
    userDataBytes: 1024, dbBytes: 1024, attachmentsBytes: 1024, extensionsBytes: 1024, logsBytes: 1024,
    otherBytes: 0, browserCacheBytes: 0, browserCacheFiles: 0
  },
  traces: { rows: 0, maxRowsInOneConversation: 0 },
  kb: {
    total: 0,
    byStatus: { pending: 0, parsing: 0, indexing: 0, ready: 0, error: 0 },
    errorDocs: [],
    integrity: { orphanVectors: 0, orphanChunks: 0, brokenDocs: [], duplicates: [], providerIssues: [] },
    vectorIndex: { count: 0, dims: [] }
  },
  backup: { configured: false, enabled: false, intervalHours: 24, lastRunAt: null, lastOkAt: null, lastError: null },
  tasks: { kbHealthCheckLastRunAt: null, backupVerifyLastRunAt: null },
  boot: { stages: [], totalMs: 0 },
  recentPerf: [],
  perfHistory: []
}) as unknown as DataHealthReport

describe('④ 数据健康：点「刷新」后那一发失败 ⇒ 报告画着、原因也说得出', () => {
  it('首读成功、点刷新失败 ⇒ 旧值横幅在、体积卡片仍在；再点重试成功 ⇒ 那句收回', async () => {
    let n = 0
    stubPocketai({ getDataHealth: () => (n === 0 ? (n = 1, report()) : FAIL) })
    mountWithProviders(<DataHealthPanel />)
    await settleAfter('getDataHealth')
    expect(alerts()).toEqual([])
    expect(screen.getByText(L('dh.db'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: L('dh.refresh') }))
    await settleAfter('getDataHealth', 2)
    expect(alerts()).toEqual([STALE(L('set.dataHealth'), '库被占用')])
    expect(screen.getByText(L('dh.db'))).toBeTruthy()

    stubPocketai({ getDataHealth: () => report() })
    fireEvent.click(screen.getByTestId('data-health-stale-retry'))
    await waitFor(() => expect(calledFns().filter((f) => f === 'getDataHealth').length).toBe(3))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
  })

  it('反向对照：首读就失败 ⇒ 仍是 §222 那句「读不到」（本批没动那条路）', async () => {
    stubPocketai({ getDataHealth: () => FAIL })
    mountWithProviders(<DataHealthPanel />)
    await settleAfter('getDataHealth')
    expect(alerts()).toEqual([FAILED('库被占用')])
  })
})

// ───────────────────────────── ⑤ 用量汇总（切时间窗） ─────────────────────────────
const summary = (requests: number): UsageSummary => ({
  days: 30, totals: { requests, promptTokens: 100, completionTokens: 50, totalTokens: 150, cachedTokens: 0, cost: 0 },
  daily: [], byProvider: [], byModel: []
}) as unknown as UsageSummary
const okReads = {
  getUsageConversations: () => [] as UsageConversationItem[],
  getUsageAssistants: () => [] as UsageAssistantItem[],
  getUsagePricing: () => ({ currency: 'CNY', prices: {} }) as unknown as UsagePricing,
  getUsageBudget: () => ({ daily: null, monthly: null, hardBlock: false, warnEnabled: true, todayCost: 0, monthCost: 0 })
}

describe('⑤ 用量汇总：默认窗 30 天，点到「近 7 天」那一发失败 ⇒ 屏上还是上一次读到的数，但那句必须说得出', () => {
  it('首读到 requests=7、切窗失败 ⇒ 旧值横幅在且那个 7 还画着；重试读到 9 ⇒ 那句收回、新数上屏', async () => {
    let fail = false
    stubPocketai({ ...okReads, getUsageSummary: () => (fail ? FAIL : summary(7)) })
    mountWithProviders(<UsagePanel />)
    await settleAfter('getUsageSummary')
    expect(alerts()).toEqual([])
    expect(screen.getByText('7')).toBeTruthy()

    fail = true
    fireEvent.click(screen.getByRole('button', { name: L('usage.days7') }))
    await waitFor(() => expect(alerts()).toEqual([STALE(L('set.usage'), '库被占用')]))
    // 旧数照常在屏上（这正是危险之处：那一屏的导出与明细全按它摆）
    expect(screen.getByText('7')).toBeTruthy()

    stubPocketai({ ...okReads, getUsageSummary: () => summary(9) })
    fireEvent.click(screen.getByTestId('usage-summary-stale-retry'))
    await waitFor(() => expect(calledFns().filter((f) => f === 'getUsageSummary').length).toBe(3))
    await settle()
    // 成功侧必须把原因收回：新数上了屏还挂着「上一次读到的值」＝本批自己造的假警报
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.getByText('9')).toBeTruthy()
  })
})

// ─────────────────────── ⑥ Ollama 运行时状态（启停后立刻再读一发） ───────────────────────
const ollamaStatus = (): OllamaRuntimeStatus => ({
  platformSupported: true, installed: true, running: true, source: 'portable', version: '0.9.9',
  installDir: 'runtime/ollama-test', modelsDir: 'data/ollama-models', downloadUrl: null, downloadBytes: null, models: []
})
const ollamaStubs = (status: () => unknown): Record<string, unknown> => ({
  getOllamaStatus: status,
  getOllamaMirror: () => ({ ok: true, mirror: '' }),
  recommendModels: () => ({ ok: true, data: null }),
  startOllama: () => ({ ok: true }),
  stopOllama: () => ({ ok: true }),
  onOllamaInstallEvent: () => () => { /* 订阅卸载函数 */ },
  onOllamaPullEvent: () => () => { /* 订阅卸载函数 */ }
})

describe('⑥ Ollama 面板：这块每 8s 轮询一次，启停后还会立刻再来一发', () => {
  it('首读运行中、停止后那一发失败 ⇒ 「运行中」还画着、旧值横幅也挂着', async () => {
    let n = 0
    stubPocketai(ollamaStubs(() => (n === 0 ? (n = 1, ollamaStatus()) : FAIL)) as never)
    mountWithProviders(<OllamaPanel />)
    await settleAfter('getOllamaStatus')
    expect(alerts()).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('ollama.stop')) }))
    await settleAfter('getOllamaStatus', 2)
    expect(alerts()).toEqual([STALE(L('ollama.title'), '库被占用')])
    expect(toasts()).toEqual([]) // 轮询失败不许刷屏（§222 那条口径不变）
    // 危险之处就在这儿：旧 status.running 还是真 ⇒ 那颗「停止」键照旧挂在屏上可点
    expect(screen.getByRole('button', { name: new RegExp(L('ollama.stop')) })).toBeTruthy()
  })

  it('成功侧必须把原因收回：下一发轮询／重试读到新状态 ⇒ 那句当场收回（否则新值上屏还挂着"这是旧值"）', async () => {
    let fail = false
    stubPocketai(ollamaStubs(() => (fail ? FAIL : { ...ollamaStatus(), running: true })) as never)
    mountWithProviders(<OllamaPanel />)
    await settleAfter('getOllamaStatus')
    expect(alerts()).toEqual([])

    fail = true
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('ollama.stop')) }))
    await settleAfter('getOllamaStatus', 2)
    expect(alerts()).toEqual([STALE(L('ollama.title'), '库被占用')])

    fail = false
    fireEvent.click(screen.getByTestId('ollama-status-stale-retry'))
    await settleAfter('getOllamaStatus', 3)
    await waitFor(() => expect(alerts()).toEqual([]))
  })
})

// ─────────────────────────── ⑦ 管家页模型推荐（那颗「重新检测」） ───────────────────────────
// 桩照 §255 那份形状写死：缺字段编译期就红，避免断言靠默认值假绿。
const RECO: ModelRecommendation = {
  tier: 'entry',
  summary: 'cpu_low',
  summaryParams: {},
  localPicks: [{ id: 'PROBE-PICK:latest', tag: 'primary', reason: 'qwen3b_q4_lowvram', installed: false }],
  onlineHint: 'low_end',
  ollamaRunning: true,
  installedModels: [],
  warnings: []
}
const hardwareSample = {
  os: { platform: 'win32', release: '10.0', arch: 'x64', hostname: 'BOX' },
  cpu: { model: 'X', cores: 8 },
  memory: { total: 16 * 1024 ** 3, free: 8 * 1024 ** 3 },
  gpus: [],
  disk: { type: 'SSD', freeSpace: 1024 ** 3, removable: false }
}
const healthSample = {
  totalConversations: 3, totalMessages: 12, kbCount: 1, totalAttachmentsBytes: 0, orphanMessages: 0, orphanChunks: 0
}
const stewardStubs = (recommendModels: () => unknown): Record<string, unknown> => ({
  getHardwareInfo: () => ({ ok: true, data: hardwareSample }),
  checkIntegrity: () => ({ ok: true, data: { ok: true, details: 'ok' } }),
  getHealthReport: () => ({ ok: true, data: healthSample }),
  getUpdateInfo: () => ({ isPackaged: false, currentVersion: '0.9.9', autoUpdateEnabled: false }),
  onOllamaPullEvent: () => () => { /* 订阅卸载函数 */ },
  recommendModels
})

describe('⑦ 管家页：「重新检测」后 recommendModels 失败 ⇒ 旧推荐上面挂那句', () => {
  it('首读拿到推荐、重探失败 ⇒ 徽标仍在屏上＋旧值横幅在', async () => {
    let fail = false
    stubPocketai(stewardStubs(() => (fail ? { ok: false, error: '探针挂了' } : { ok: true, data: RECO })) as never)
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())
    expect(alerts()).toEqual([])

    fail = true
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('steward.recheck')) }))
    await waitFor(() => expect(alerts()).toEqual([STALE(L('steward.modelRec'), '探针挂了')]))
    // 那一屏的档位徽标照旧画着——它才是这句横幅存在的理由
    expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull()
  })

  it('成功侧必须把原因收回：再点一次「重新检测」读到新推荐 ⇒ 那句当场收回', async () => {
    let fail = false
    stubPocketai(stewardStubs(() => (fail ? { ok: false, error: '探针挂了' } : { ok: true, data: RECO })) as never)
    mountWithProviders(<StewardModule />)
    await waitFor(() => expect(screen.queryByText('PROBE-PICK:latest')).not.toBeNull())

    fail = true
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('steward.recheck')) }))
    await waitFor(() => expect(alerts()).toEqual([STALE(L('steward.modelRec'), '探针挂了')]))

    fail = false
    fireEvent.click(screen.getByTestId('steward-rec-stale-retry'))
    await waitFor(() => expect(alerts()).toEqual([]))
  })
})
