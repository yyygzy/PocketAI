// @vitest-environment jsdom
// V4-Iter-352：「读不到」那张脸剩下的那一档里，先收"重拉者已经具名、这一支同屏真没出口"的四处。
//
// 为什么这三处值得真挂载、第四处（对话页消息）不值得（§352 的分诊尺子＝"这一发有没有用户在这屏上
// **命令得动**的重读入口"，账写在闸门 `load-fail-read-retry-gate-350.test.ts` 头部）：
//   · Ollama 面板：读不到的时候**整个操作区都不渲染**（它的条件是 `status` 在场）⇒
//     屏上只有那一句，安装／启动／停止一颗都点不到，而 8s 轮询是系统重发、不是用户命令得动的；
//   · 定时备份：`!schedule` 时下面那一整块（含开关与周期）不出现⇒ 屏上没有会再发这一发的东西；
//     §345 那颗 `schedule-stale-retry` 长在"已经有旧值"那一支，两扇互斥；
//   · 加密面板：早退 return＝整块面板（含改口令／关闭加密）换成那一句，`onChange` 就是父页那份副本的 refresh；
//   · 对话页的消息那一发：`ChatModule` 全仓不挂载（§309 起就是这么记的）⇒ 只有闸门看得见，
//     这里不硬造夹具，账落清单的 B 行。
//
// 每处三条：①那句与那颗键同屏、键在 `role="alert"` 盒子**外面**（§268）；②按下去真再发一发；
// ③到货后那句当场收回、脸整块换成本体。反向对照两条：还在加载那一支不许有键；
// "有旧值"那一支的 stale 键不许和这张脸同时出现。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import { OllamaPanel } from '../src/renderer/src/components/OllamaPanel'
import { BackupPanel, EncryptionPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { EncryptionStatus, OllamaRuntimeStatus, WebDAVBackupFile } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const RETRY = L('agent.retryRead')
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const FAIL = { ok: false, error: '库被占用' }

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

// ─────────────────────────────── ① Ollama 运行时状态 ───────────────────────────────
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

describe('Ollama 面板：首读就失败 ⇒ 操作区根本不在屏上，这一支得自带出口', () => {
  it('失败脸有键、那颗键在 alert 外面、操作区那两颗键此时都点不到 ⇒ 按下去真再发一发 ⇒ 到货后那句与那颗键一起撤', async () => {
    stubPocketai(ollamaStubs(() => FAIL) as never)
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('ollama-status-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)
    // 这一支"同屏没出口"的 DOM 证据：操作区整块的条件要 status 在场
    expect(screen.queryByRole('button', { name: new RegExp(L('ollama.start')) })).toBeNull()
    expect(screen.queryByRole('button', { name: new RegExp(L('ollama.install')) })).toBeNull()
    // 也不许同时挂 §345 那颗"停在上一份"的键（两扇互斥）
    expect(screen.queryByTestId('ollama-status-stale-retry')).toBeNull()

    stubPocketai(ollamaStubs(() => ollamaStatus()) as never)
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('ollama-status-read-retry')).toBeNull()
    expect(screen.getAllByText(L('ollama.portableSource'), { exact: false }).length).toBeGreaterThan(0)
  })

  it('反向对照：还在加载那一支（status 与 statusErr 都还没到）不许有那颗键', async () => {
    let pending = true
    stubPocketai(
      ollamaStubs(() =>
        pending
          ? new Promise<unknown>(() => {
              /* 不落到：这一发永远在飞 */
            })
          : ollamaStatus()) as never
    )
    mountWithProviders(<OllamaPanel />)
    await waitFor(() => expect(callsOf('getOllamaStatus')).toBe(1))
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('ollama-status-read-retry')).toBeNull()
    pending = false
  })
})

// ─────────────────────────────── ② 定时备份那一发 ───────────────────────────────
const CFG = { url: 'https://dav.example.com/old', username: 'me', passwordCipher: 'x', directory: '/b' }
const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }
const FILE: WebDAVBackupFile = { name: 'pocketai-full-2026-10-25.zip', size: 1024, mtime: 1, encrypted: false, kind: 'full' }

type Impl = (...a: unknown[]) => unknown
const mountBackup = (over: Record<string, Impl> = {}): void => {
  stubPocketai({
    loadWebDAVConfig: () => CFG,
    getBackupSchedule: () => SCHED,
    listWebDAVBackups: () => [FILE],
    saveWebDAVConfig: (c: unknown) => ({ ok: true, cfg: c }),
    setBackupSchedule: (p: unknown) => ({ ...SCHED, ...(p as object) }),
    testWebDAV: () => ({ ok: true }),
    restoreLocalBackup: () => ({ ok: true }),
    mergeScanWebDAVBackup: () => ({ ok: true, tables: [], attachmentsToAdd: 0 }),
    ...over
  })
  mountWithProviders(<BackupPanel enc={null} />)
}

describe('定时备份：首读就失败 ⇒ 开关那一整块不出现，那颗 stale 键也不在屏上，这一支补自己的出口', () => {
  it('失败脸有键 ⇒ 按下去真多发一发 getBackupSchedule ⇒ 到货后定时块上屏、那句收回', async () => {
    let fail = true
    mountBackup({ getBackupSchedule: () => (fail ? FAIL : SCHED) })
    await waitFor(() => expect(callsOf('getBackupSchedule')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('backup-schedule-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)
    expect(screen.queryByTestId('schedule-stale-retry')).toBeNull()
    // 这一支没有出口的另一半证据：定时块（那颗开关）此刻不在屏上
    expect(screen.queryByText(L('bk.scheduleEnable'))).toBeNull()

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getBackupSchedule')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('backup-schedule-read-retry')).toBeNull()
    expect(screen.getByText(L('bk.scheduleEnable'))).toBeTruthy()
  })
})

// ─────────────────────────────── ③ 加密面板（props 驱动） ───────────────────────────────
const enc = (over: Partial<EncryptionStatus> = {}): EncryptionStatus =>
  ({
    mode: 'db', dbEncrypted: true, unlocked: true, masterPasswordVerified: true, recoveryKeyExists: false,
    kdfN: 131072, kdfAtCurrentTier: true, autoLockMinutes: 5, ...over
  }) as EncryptionStatus
// props 驱动的面板在数据到位后还会自己拉锁状态／恢复密钥，桩不给就是 not a function（§225 同形）
const PANEL_STUBS = {
  getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 0 }),
  hasRecoveryKey: () => false,
  getLicenseFingerprint: () => 'fp-1234'
}

describe('加密面板：副本还没出生就失败 ⇒ 整块面板换成那一句，那颗键必须喊父页重取', () => {
  it('enc 为空＋有原因 ⇒ 那句旁边有键、按下去只喊一次 onChange（面板自己没有那一发读）', async () => {
    let n = 0
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<EncryptionPanel enc={null} err={'库被占用'} onChange={() => { n++ }} />)
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('encryption-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)
    expect(screen.queryByTestId('enc-stale-retry')).toBeNull()

    fireEvent.click(key)
    await settle()
    expect(n, '那颗键必须打到父页交下来的重取入口，不然它只是一句装饰').toBe(1)
    expect(alerts(), '调用重取入口不等于新读数到货：这一发没有新数据，那句必须还挂着').toEqual([FAILED('库被占用')])
  })

  it('反向对照：副本在场、重读失败 ⇒ 换的是 §345 那颗 stale 键，这一颗不许同时出现', async () => {
    stubPocketai(PANEL_STUBS)
    mountWithProviders(<EncryptionPanel enc={enc()} err={'库被占用'} onChange={() => {}} />)
    expect(screen.getByTestId('enc-stale-retry')).toBeTruthy()
    expect(screen.queryByTestId('encryption-read-retry')).toBeNull()
  })
})
