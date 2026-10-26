// V4-Iter-324 挂载用例：备份那一屏「一个屏多个在飞」的三处，迟到那发一个字都不许写屏。
//
// 为什么必须真挂载：这三处的缺陷本体就在"响应到货之后"那几行 setState 上——
// 桥层用例证得了主进程回了什么，证不了界面把哪一份画上了屏。
// 三张脸（本批前的改前形状）：
// ① 关掉弹层去点另一份的「合并」⇒ 屏上是 A 的冲突表而 mergeFilename 已是 B ⇒ 执行拿 B 的文件名＋A 的密码真去合并；
// ② 为 B 输入备份密码时，A 那发的迟到回执把弹窗目标改回 A（那份密码打给了另一个文件），迟到的成功还会清掉输入＋多报一句「恢复成功」；
// ③ 改过 WebDAV 地址后，旧地址那发的迟到清单把内容盖回当前屏（清单来自另一台服务器），先回的还会把「还在加载」翻掉。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { WebDAVBackupFile } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''

const CFG = { url: 'https://dav.example.com/backups', username: 'me', passwordCipher: 'x', directory: '/b' }
const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }

const mkFile = (name: string): WebDAVBackupFile => ({
  name,
  size: 1024,
  mtime: 1,
  encrypted: false,
  kind: 'full'
})
const FILE_A = mkFile('pocketai-full-2026-10-20.zip')
const FILE_B = mkFile('pocketai-full-2026-10-25.zip')

/** 两份报告用各自独有的表名区分（弹窗里表名是原样渲染的） */
const SCAN_A = { ok: true, tables: [{ table: 'conversations', cloudOnly: 0, localOnly: 0, both: 1 }], attachmentsToAdd: 0 }
const SCAN_B = { ok: true, tables: [{ table: 'mcp_servers', cloudOnly: 0, localOnly: 0, both: 2 }], attachmentsToAdd: 0 }

/** 一次交互打两发同名通道 ⇒ 桩的 resolve 必须存队列（单槽会被后到的顶掉，迟到响应就演不出来） */
interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
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
    inflight.push({ promise, resolve })
    return promise
  }
  /** 按发起顺序取第 n 发来回答（0＝先发起的那发） */
  const answer = (n: number, value: T): void => {
    inflight[n]!.resolve(value)
    return inflight[n]!.promise as never
  }
  const settle = async (n: number): Promise<void> => {
    await inflight[n]!.promise
    await new Promise((r) => setTimeout(r, 0))
  }
  return { impl, args, answer, settle, count: () => inflight.length }
}

/** 行内三颗键的顺序是 恢复／合并／删除 ⇒ 按行取第二颗（「合并」「恢复」这些标签在屏上不止一只） */
async function clickMerge(name: string): Promise<void> {
  const row = (await screen.findByText(name)).closest('tr')!
  fireEvent.click(row.querySelectorAll('button')[1]!)
}

type Impl = (...a: unknown[]) => unknown

const mountBackup = (over: Record<string, Impl> = {}): void => {
  stubPocketai({
    loadWebDAVConfig: () => CFG,
    getBackupSchedule: () => SCHED,
    listWebDAVBackups: () => [FILE_A, FILE_B],
    saveWebDAVConfig: (c: unknown) => ({ ok: true, cfg: c }),
    mergeScanWebDAVBackup: () => SCAN_A,
    mergeExecuteWebDAVBackup: () => ({ ok: true }),
    restoreWebDAVBackup: () => ({ ok: true }),
    restoreLocalBackup: () => ({ ok: true }),
    deleteWebDAVBackup: () => ({ ok: true }),
    uploadWebDAVBackup: () => ({ ok: true, filename: 'x' }),
    uploadIncrementalBackup: () => ({ ok: true, attachmentsTotal: 0, blobsUploaded: 0, blobsSkipped: 0, bytesUploaded: 0 }),
    testWebDAV: () => ({ ok: true }),
    ...over
  })
  mountWithProviders(<BackupPanel enc={null} />)
}

/** 走到「确认恢复」那一步：某一行上的「恢复」⇒ 通用确认框点「确认」 */
async function clickRestoreAndWaitConfirm(name: string): Promise<void> {
  const row = (await screen.findByText(name)).closest('tr')!
  fireEvent.click(row.querySelector('button')!)
  fireEvent.click(await screen.findByRole('button', { name: L('common.confirm') }))
}

describe('§324① 合并扫描：迟到那发不许把冲突表画到另一份文件的弹窗上', () => {
  it('连点两行的「合并」、先发的后回 ⇒ 屏上必须是后点那一份的表，执行也带那一份的文件名', async () => {
    const scan = makeQueue<{ ok: boolean; tables: { table: string; cloudOnly: number; localOnly: number; both: number }[]; attachmentsToAdd: number }>()
    const exec = makeQueue<{ ok: boolean }>()
    mountBackup({ mergeScanWebDAVBackup: scan.impl, mergeExecuteWebDAVBackup: exec.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE_B.name))

    await clickMerge(FILE_A.name)
    await waitFor(() => expect(scan.count()).toBe(1))
    await clickMerge(FILE_B.name)
    await waitFor(() => expect(scan.count()).toBe(2))

    // 后发的先到 ⇒ 该写的都写
    scan.answer(1, SCAN_B)
    await scan.settle(1)
    expect(bodyText()).toContain('mcp_servers')

    // 先发的迟到 ⇒ 不许把表换成 A 那份（此刻执行键拿的是 B 的文件名）
    scan.answer(0, SCAN_A)
    await scan.settle(0)
    expect(bodyText()).not.toContain('conversations')
    expect(bodyText()).toContain('mcp_servers')

    fireEvent.click(screen.getByText(L('bk.mergeStrategyCloud')))
    await waitFor(() => expect(exec.count()).toBe(1))
    expect(exec.args[0]![0], '执行那发必须是最新点开的 B，不是迟到那份的 A').toBe(FILE_B.name)
  })

  it('反向对照：只有那一发在飞时，它自己必须能写屏（守卫不许写成恒不写）', async () => {
    const scan = makeQueue<typeof SCAN_A>()
    const exec = makeQueue<{ ok: boolean }>()
    mountBackup({ mergeScanWebDAVBackup: scan.impl, mergeExecuteWebDAVBackup: exec.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE_A.name))
    await clickMerge(FILE_A.name)
    await waitFor(() => expect(scan.count()).toBe(1))
    scan.answer(0, SCAN_A)
    await scan.settle(0)
    expect(bodyText()).toContain('conversations')
    fireEvent.click(screen.getByText(L('bk.mergeStrategyCloud')))
    await waitFor(() => expect(exec.args[0]![0]).toBe(FILE_A.name))
  })

  it('「还在扫描」归最新那发管：先回的那条不许把它翻掉', async () => {
    const scan = makeQueue<typeof SCAN_A>()
    mountBackup({ mergeScanWebDAVBackup: scan.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE_B.name))
    await clickMerge(FILE_A.name)
    await clickMerge(FILE_B.name)
    await waitFor(() => expect(scan.count()).toBe(2))

    scan.answer(0, SCAN_A) // 迟到的先发先回
    await scan.settle(0)
    expect(bodyText(), '最新那发还在飞 ⇒ 屏上必须还写着「正在扫描」').toContain(L('bk.mergeScanning'))
    expect(bodyText()).not.toContain('conversations')

    scan.answer(1, SCAN_B)
    await scan.settle(1)
    expect(bodyText()).toContain('mcp_servers')
    expect(bodyText()).not.toContain(L('bk.mergeScanning'))
  })
})

describe('§324② 恢复那发：迟到的回执不许改弹窗目标，也不许清掉正在输入的密码', () => {
  it('A 那发迟到的「需要备份密码」不许把目标改回 A ⇒ 重试发出去的是 B', async () => {
    const restore = makeQueue<{ ok: boolean; code?: string; error?: string; passwordChanged?: boolean }>()
    mountBackup({ restoreWebDAVBackup: restore.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE_B.name))

    await clickRestoreAndWaitConfirm(FILE_A.name)
    await waitFor(() => expect(restore.count()).toBe(1))
    await clickRestoreAndWaitConfirm(FILE_B.name)
    await waitFor(() => expect(restore.count()).toBe(2))

    restore.answer(1, { ok: false, code: 'needBackupPassword', error: '解不开' })
    await restore.settle(1)
    await waitFor(() => expect(bodyText()).toContain(L('bk.restorePwdTitle')))
    expect(bodyText()).toContain(FILE_B.name)

    restore.answer(0, { ok: false, code: 'needBackupPassword', error: '解不开' })
    await restore.settle(0)
    expect(bodyText(), '目标不许被迟到那发改回 A').toContain(FILE_B.name)
    expect(bodyText()).not.toContain(`${L('bk.restorePwdHint',).replace('{name}', FILE_A.name)}`)

    const box = screen.getByPlaceholderText(L('bk.restorePwdPlaceholder')) as HTMLInputElement
    fireEvent.change(box, { target: { value: '备份密码' } })
    // 密码弹窗里那颗「恢复」与列表行上那颗同名 ⇒ 取弹层里那一只（弹层渲染在最后）
    fireEvent.click(screen.getAllByText(L('bk.restorePwdConfirm')).at(-1)!)
    await waitFor(() => expect(restore.count()).toBe(3))
    expect(restore.args[2]![0], '用户是给 B 输的密码，就不许发给 A').toBe(FILE_B.name)

    // 重试那一发回完（这一发不关弹窗：密码不对），「重试中」必须自己退场，
    // 否则密码框与那颗键永久禁用、连遮罩都点不动（复位行被我一度删掉过，就是这条逮的）
    restore.answer(2, { ok: false, code: 'badPassword', error: '密码不对' })
    await restore.settle(2)
    expect(box.disabled, 'busy 不复位＝弹窗永久卡死').toBe(false)
    expect(bodyText()).toContain(L('bk.restoreBadPwd'))
  })

  it('迟到的成功不许报「恢复成功」，也不许把人家的密码输入清空', async () => {
    const restore = makeQueue<{ ok: boolean; code?: string; passwordChanged?: boolean; error?: string }>()
    mountBackup({ restoreWebDAVBackup: restore.impl })
    await waitFor(() => expect(bodyText()).toContain(FILE_B.name))

    await clickRestoreAndWaitConfirm(FILE_A.name)
    await waitFor(() => expect(restore.count()).toBe(1))
    await clickRestoreAndWaitConfirm(FILE_B.name)
    await waitFor(() => expect(restore.count()).toBe(2))

    restore.answer(1, { ok: false, code: 'needBackupPassword', error: '解不开' })
    await restore.settle(1)
    const box = (await screen.findByPlaceholderText(L('bk.restorePwdPlaceholder'))) as HTMLInputElement
    fireEvent.change(box, { target: { value: '打字打到一半' } })

    restore.answer(0, { ok: true }) // A 那发其实成功了，但它不是最新那次
    await restore.settle(0)
    expect(bodyText(), '另一份的成功不能替这一次说话').not.toContain(L('bk.restoreOk'))
    expect(box.value).toBe('打字打到一半')
    expect(bodyText()).toContain(FILE_B.name)
  })
})

describe('§324③ 云端清单：旧地址那发迟到不许盖掉新清单，也不许翻掉「还在加载」', () => {
  it('手动刷新在飞时改了地址并保存 ⇒ 迟到那份不许把旧清单画回当前屏', async () => {
    const list = makeQueue<WebDAVBackupFile[]>()
    mountBackup({ listWebDAVBackups: list.impl })
    // 第 0 发是"配置到货之后"由 effect 发的（挂载时 cfg 还是 null）⇒ 先等它出现再答，序号才可辨认
    await waitFor(() => expect(list.count()).toBe(1))
    list.answer(0, [FILE_A, FILE_B])
    await list.settle(0)
    await waitFor(() => expect(bodyText()).toContain(FILE_B.name))

    fireEvent.click(screen.getByText(L('bk.refresh')))
    await waitFor(() => expect(list.count()).toBe(2))
    // 改地址＋保存 ⇒ effect 用新 cfg 再拉一次（第 3 发是最新那发）
    fireEvent.change(screen.getByDisplayValue(CFG.url), { target: { value: 'https://new.example.com/d' } })
    fireEvent.click(screen.getByText(L('bk.saveCfg')))
    await waitFor(() => expect(list.count()).toBe(3))

    list.answer(2, [FILE_B]) // 新地址的先回
    await list.settle(2)
    list.answer(1, [FILE_A]) // 旧地址那份迟到
    await list.settle(1)

    expect(bodyText(), '屏上清单必须来自最新那发（新地址），不许被旧地址那份盖回').toContain(FILE_B.name)
    expect(bodyText()).not.toContain(FILE_A.name)
  })

  it('「还在加载」也归最新那发管：先回的那条不许把它翻掉', async () => {
    const list = makeQueue<WebDAVBackupFile[]>()
    mountBackup({ listWebDAVBackups: list.impl })
    await waitFor(() => expect(list.count()).toBe(1))
    list.answer(0, [FILE_A, FILE_B])
    await list.settle(0)

    fireEvent.click(screen.getByText(L('bk.refresh')))
    await waitFor(() => expect(list.count()).toBe(2))
    fireEvent.change(screen.getByDisplayValue(CFG.url), { target: { value: 'https://new.example.com/d' } })
    fireEvent.click(screen.getByText(L('bk.saveCfg')))
    await waitFor(() => expect(list.count()).toBe(3))

    list.answer(1, [FILE_A]) // 旧那发先回
    await list.settle(1)
    expect(bodyText(), '最新那发还在飞 ⇒ 「正在加载」不许消失').toContain(L('bk.listLoading'))

    list.answer(2, [FILE_B])
    await list.settle(2)
    expect(bodyText()).not.toContain(L('bk.listLoading'))
    expect(bodyText()).toContain(FILE_B.name)
  })

  it('反向对照：单发刷新自己必须能写屏（守卫不许写成恒不写）', async () => {
    const list = makeQueue<WebDAVBackupFile[]>()
    mountBackup({ listWebDAVBackups: list.impl })
    await waitFor(() => expect(list.count()).toBe(1))
    list.answer(0, [FILE_A])
    await list.settle(0)
    fireEvent.click(screen.getByText(L('bk.refresh')))
    await waitFor(() => expect(list.count()).toBe(2))
    list.answer(1, [FILE_A, FILE_B])
    await list.settle(1)
    await waitFor(() => expect(bodyText()).toContain(FILE_B.name))
    expect(bodyText()).not.toContain(L('bk.listLoading'))
  })
})
