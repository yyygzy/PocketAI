// V4-Iter-325 挂载用例：备份那一屏剩下三处"说了没做／先回的替最新那发说话"。
//
// ① 定时计划：连点两颗开关 ⇒ 两发写在飞，先回的那条会把面板回弹成旧一次的结果；
// ② 测试连接：改了 URL 再测一次，先回的旧地址那条会把「连接成功」盖在新地址的结论上；
// ③ 本地恢复（真机 B177 撞出的那条）：弹框之前那句「正在下载恢复…」既说了一件当时根本没发生的事
//    （那会儿在等用户挑文件），用户取消后又直接 return ⇒ 那句永远挂在屏上。
//    修法＝换成一句对两段都成立的话术，并在取消时收回。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { WebDAVBackupFile } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''

const CFG = { url: 'https://dav.example.com/old', username: 'me', passwordCipher: 'x', directory: '/b' }
const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }
const FILE: WebDAVBackupFile = { name: 'pocketai-full-2026-10-25.zip', size: 1024, mtime: 1, encrypted: false, kind: 'full' }

type Impl = (...a: unknown[]) => unknown

/** 一次交互打两发同名通道 ⇒ resolve 存队列，不能只留一格 */
interface Deferred<T> {
  resolve: (v: T) => void
  promise: Promise<T>
}
const makeQueue = <T,>() => {
  const inflight: Deferred<T>[] = []
  const args: unknown[][] = []
  const impl = (...a: unknown[]): Promise<T> => {
    let resolve!: (v: T) => void
    const promise = new Promise<T>((r) => {
      resolve = r
    })
    args.push(a)
    inflight.push({ resolve, promise })
    return promise
  }
  const answer = (n: number, value: T): void => inflight[n]!.resolve(value)
  const settle = async (n: number): Promise<void> => {
    await inflight[n]!.promise
    await new Promise((r) => setTimeout(r, 0))
  }
  return { impl, args, answer, settle, count: () => inflight.length }
}

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

/** 应用内确认框（「从本地文件恢复」那发会先问一次） */
async function confirmInApp(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: L('common.confirm') }))
}

const clickButton = (label: string): void => {
  fireEvent.click(screen.getByText(label))
}

describe('§325③ 本地恢复那发的进度话术：对两段都成立，取消时收回', () => {
  it('选择器还开着（用户正在挑文件）⇒ 屏上那句必须已经摆出来，且不再说「正在下载」', async () => {
    const restore = makeQueue<{ ok: boolean; canceled?: boolean }>()
    mountBackup({ restoreLocalBackup: restore.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    clickButton(L('bk.localRestoreBtn'))
    await confirmInApp()
    await waitFor(() => expect(restore.count()).toBe(1))
    expect(bodyText()).toContain(L('bk.localRestoring'))
    expect(bodyText(), '那一会儿主进程只是在等挑文件，"正在下载恢复"是句没发生的事').not.toContain(L('bk.downloadingRestore'))
  })

  it('在选择器里取消 ⇒ 那句收回，屏上既没有进度也没有半句「恢复成功」', async () => {
    const restore = makeQueue<{ ok: boolean; canceled?: boolean }>()
    mountBackup({ restoreLocalBackup: restore.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    clickButton(L('bk.localRestoreBtn'))
    await confirmInApp()
    await waitFor(() => expect(restore.count()).toBe(1))
    expect(bodyText()).toContain(L('bk.localRestoring'))

    restore.answer(0, { ok: true, canceled: true })
    await restore.settle(0)
    expect(bodyText(), '陈句要收回——真机 B177 撞的就是这条挂着不走').not.toContain(L('bk.localRestoring'))
    expect(bodyText()).not.toContain(L('bk.restoreOk'))
    expect(bodyText()).not.toContain(L('bk.restoreFail'))
  })

  it('反向对照：那一发真的走完 ⇒ 结果句盖过进度句', async () => {
    const restore = makeQueue<{ ok: boolean; canceled?: boolean; error?: string }>()
    mountBackup({ restoreLocalBackup: restore.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    clickButton(L('bk.localRestoreBtn'))
    await confirmInApp()
    await waitFor(() => expect(restore.count()).toBe(1))
    restore.answer(0, { ok: false, error: '备份包损坏' })
    await restore.settle(0)
    expect(bodyText()).toContain(L('bk.restoreFail').replace('{e}', '备份包损坏'))
    expect(bodyText()).not.toContain(L('bk.localRestoring'))
  })
})

describe('§325② 测试连接：结论必须来自最新那次输入的地址', () => {
  it('改过 URL 再测、先发的后回 ⇒ 屏上不许换成旧地址那句「连接成功」', async () => {
    const test = makeQueue<{ ok: boolean; message?: string }>()
    mountBackup({ testWebDAV: test.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    clickButton(L('bk.testConn'))
    await waitFor(() => expect(test.count()).toBe(1))

    fireEvent.change(screen.getByDisplayValue(CFG.url), { target: { value: 'https://new.example.com/d' } })
    clickButton(L('bk.testConn'))
    await waitFor(() => expect(test.count()).toBe(2))
    expect((test.args[1]![0] as { url: string }).url, '第二发必须带上刚改的新地址').toBe('https://new.example.com/d')

    test.answer(1, { ok: false, message: '新地址不通' })
    await test.settle(1)
    expect(bodyText()).toContain(L('bk.connFail').replace('{e}', '新地址不通'))

    test.answer(0, { ok: true })
    await test.settle(0)
    expect(bodyText(), '旧那发迟到的成功不许替新那发说话').not.toContain(L('bk.connOk'))
    expect(bodyText()).toContain('新地址不通')
  })

  it('反向对照：单发测试自己必须能写屏', async () => {
    const test = makeQueue<{ ok: boolean; message?: string }>()
    mountBackup({ testWebDAV: test.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    clickButton(L('bk.testConn'))
    await waitFor(() => expect(test.count()).toBe(1))
    test.answer(0, { ok: true })
    await test.settle(0)
    expect(bodyText()).toContain(L('bk.connOk'))
  })
})

describe('§325① 定时计划：面板回弹必须跟着最新那发的回执', () => {
  const box = (): HTMLInputElement => document.querySelector('input[type=checkbox]') as HTMLInputElement

  it('连点两颗开关、先发的后回 ⇒ 迟到的那条不许把计划回弹成旧一次的勾选态', async () => {
    const sched = makeQueue<typeof SCHED>()
    mountBackup({ setBackupSchedule: sched.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    fireEvent.click(box())
    fireEvent.click(box())
    await waitFor(() => expect(sched.count()).toBe(2))

    sched.answer(1, { ...SCHED, enabled: false }) // 最新那发：主进程没给开
    await sched.settle(1)
    expect(box().checked).toBe(false)

    sched.answer(0, { ...SCHED, enabled: true }) // 旧那发迟到：说"开了"
    await sched.settle(0)
    expect(box().checked, '面板不许被迟到回执回弹成勾选').toBe(false)
  })

  it('反向对照：单发保存的回执自己必须能写屏', async () => {
    const sched = makeQueue<typeof SCHED>()
    mountBackup({ setBackupSchedule: sched.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE.name))
    fireEvent.click(box())
    await waitFor(() => expect(sched.count()).toBe(1))
    sched.answer(0, { ...SCHED, enabled: true })
    await sched.settle(0)
    expect(box().checked).toBe(true)
  })
})
