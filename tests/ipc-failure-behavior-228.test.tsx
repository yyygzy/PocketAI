// @vitest-environment jsdom
// V4-Iter-228 的界面半边：这颗下拉现在是**先乐观拨状态、再写库**，而写库从今天起真的会失败
// （`LOCK_SET_AUTO_TIMEOUT` 在锁屏白名单里，db 模式锁屏时库是关着的；SQL 出错也算）。
//
// 于是 §224 那一族的第三形状在这里有了现场：失败如果只留痕，屏上留着的就是用户刚点的新档，
// 而那**没存上**——重启才见分晓。这正是本批要修的 bug 的新版本，所以必须回滚＋说话。
// 说话的脸沿用本文件既有的操作反馈 `Notice`（读数类才走 `role="alert"`，两类不混在一个面里）。
//
// 落库那一侧（真 SQLite）在 `tests/auto-lock-persist-228.test.ts`，这里只管界面上演了什么。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { EncryptionPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { zh } from '../src/renderer/src/i18n/zh'
import type { EncryptionStatus } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.opFailed').replace('{msg}', msg)
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const sel = (): HTMLSelectElement => screen.getAllByRole('combobox')[0] as HTMLSelectElement
const shown = (): string => sel().options[sel().selectedIndex]?.text ?? '(没有选中项)'

let warns: string[] = []
beforeEach(() => {
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warns.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '))
  })
})
afterEach(() => vi.restoreAllMocks())
const traces = (): string[] => warns.filter((w) => w.startsWith('[ipc] '))

const enc = (): EncryptionStatus =>
  ({ dbEncrypted: true, unlocked: true, masterPasswordVerified: true, autoLockTimeout: 0 } as unknown as EncryptionStatus)

/** 读到的是 5 分钟；写这一发按 impl 变 */
const mount = (writeImpl: () => unknown): void => {
  stubPocketai({
    getLockStatus: () => ({ state: 'unlocked', autoLockTimeout: 300_000 }),
    hasRecoveryKey: () => false,
    setAutoLockTimeout: writeImpl
  })
  mountWithProviders(<EncryptionPanel enc={enc()} err={null} onChange={() => {}} />)
}
const pick = async (ms: number): Promise<void> => {
  fireEvent.change(sel(), { target: { value: String(ms) } })
  await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
}

describe('① 写失败要回滚、要说话', () => {
  it('resolve 的 {ok:false} ⇒ 下拉回到读到的「5 分钟」，屏上是「操作失败：数据库被锁定」，并留一条痕', async () => {
    mount(() => ({ ok: false, error: '数据库被锁定' }))
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5')))
    await pick(60_000)
    await waitFor(() => expect(screen.queryByText(FAILED('数据库被锁定'))).not.toBeNull())
    expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5'))
    expect(traces()).toEqual(['[ipc] settings.setAutoLockTimeout 失败: 数据库被锁定'])
    // 读数类那两句话这里都不该出现（这一处是操作反馈，不是"读不到"）
    expect(alerts()).toEqual([])
  })

  it('真抛错 ⇒ 同样回滚，那句的原因换成抛出来的原文', async () => {
    mount(() => Promise.reject(new Error('通道没接上')))
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5')))
    await pick(900_000)
    await waitFor(() => expect(screen.queryByText(FAILED('通道没接上'))).not.toBeNull())
    expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5'))
    expect(traces()).toEqual(['[ipc] settings.setAutoLockTimeout 失败: 通道没接上'])
  })

  it('回滚回的是"最后一次确认的值"，不是"最初读到的值"：先写成功一次、再写失败', async () => {
    let fail = false
    mount(() => (fail ? { ok: false, error: '库被占用' } : { ok: true }))
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5')))
    await pick(60_000)
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '1')))
    expect(screen.queryByText(L('enc.autoLockSaved'))).not.toBeNull()
    fail = true
    await pick(900_000)
    await waitFor(() => expect(screen.queryByText(FAILED('库被占用'))).not.toBeNull())
    // 停在 1 分钟（上一次真的存上了的那一档），而不是退回最初读到的 5 分钟
    expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '1'))
  })
})

describe('② 成功面：值留下、确认在、失败话不许出现', () => {
  it('写成功 ⇒ 显示新档、「已保存」出现、没有那句失败话、也没有 alert', async () => {
    mount(() => ({ ok: true }))
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5')))
    await pick(3_600_000)
    await waitFor(() => expect(screen.queryByText(L('enc.autoLockSaved'))).not.toBeNull())
    expect(shown()).toBe(L('enc.autoLockHour'))
    expect(screen.queryByText(FAILED('数据库被锁定'))).toBeNull()
    expect(alerts()).toEqual([])
    expect(traces()).toEqual([])
  })

  it('调用确实把选中的那一档交给了主进程（不是只改本地状态）', async () => {
    mount(() => ({ ok: true }))
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '5')))
    await pick(900_000)
    await waitFor(() => expect(shown()).toBe(L('enc.autoLockMin').replace('{n}', '15')))
    const call = pocketaiCalls().find((c) => c.fn === 'setAutoLockTimeout')
    expect(call?.args).toEqual([900000])
  })
})

describe('③ 落库那一侧的接线（源码区域断言）', () => {
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n')

  it('handler 里先写库、再改内存——顺序就是这个批的修复本身', () => {
    const src = read('src/main/ipc/handlers/lock.ts')
    const write = 'appConfigRepo.setAutoLockTimeout(timeoutMs)'
    const apply = 'lockService.setAutoTimeout(timeoutMs)'
    expect(src.split(write).length - 1, '落库那一行不在或不止一处').toBe(1)
    expect(src.split(apply).length - 1, '改内存那一行不在或不止一处').toBe(1)
    expect(src.indexOf(write), '落库必须在改内存之前').toBeLessThan(src.indexOf(apply))
    expect(src).toContain("import { appConfigRepo } from '../../db/repositories/app-config.repo'")
  })

  it('preload 的返回类型带上了失败分支（写库会真失败，类型不能只写成功）', () => {
    const src = read('src/preload/index.ts')
    expect(src.split('setAutoLockTimeout: (timeoutMs: number): Promise<{ ok: true } | { ok: false; error: string }>').length - 1).toBe(1)
  })
})
