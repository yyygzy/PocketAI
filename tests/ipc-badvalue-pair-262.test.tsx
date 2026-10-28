// V4-Iter-262：这一族名单的最后两处 B 档——「只判真值」把失败对象当好数据（沙箱预览／WebDAV 配置）。
//
// 探针实测（临时用例，跑完即删）两种真形状，都不是"看着像没有"：
//  · `getSandboxFile` 回 `{ok:false}` ⇒ `if (r)` 为真 ⇒ `preview.meta.isApp` 抛
//    **`Cannot read properties of undefined (reading 'isApp')`**，整屏被 React 卸载（body 为空＝整站崩溃屏）；
//  · `loadWebDAVConfig` 回 `{ok:false}` ⇒ `if (c)` 为真 ⇒ 失败对象写进 `cfg`，于是「同步状态」卡与
//    「⬆️ 上传备份／增量／刷新」那一整块照常摆出来（探针读数 body 里确有这些字），
//    四个输入框从 controlled 变 **uncontrolled**（React 当场警告，URL 框成空串）——
//    把"配置文件读不到"演成"你配过了，只是还没备份过"。
//
// 这两发的共同点是**有三种到货**（数据／null＝真的没有／失败对象），所以判据必须是 `hasIpcFailed`，
// 不能是 `if (v)`。收口形状沿用仓里已有的脸：沙箱那一处走本模块既有的 toast（同族其它失败都是它）＋
// 清掉上一份预览（§256"陈旧谎报要收回"）；WebDAV 那一处走 §222 的 `LoadFailNotice`（挂载那一次的读，
// toast 会在用户看到之前就消失），且与"真的还没配置"分开——null 才是"没配过"。
// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { SandboxModule } from '../src/renderer/src/modules/sandbox/SandboxModule'
import { BackupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import type { SandboxFileMeta } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const bodyText = (): string => document.body.textContent ?? ''
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())

// console.error 的换掉与还原要成对：挂在 mountBackup 返回值上、由用例自己 `done()`，
// 五个用例只有一个真的调用——其余四个跑完，console.error 还是桩，后面的用例就再也报不出错了。
const realConsoleError = console.error
const consoleErrors: string[] = []
const collect = (): void => { console.error = (...a: unknown[]) => { consoleErrors.push(String(a[0])) } }
beforeEach(collect)
afterEach(() => {
  console.error = realConsoleError
  consoleErrors.length = 0
})

// ───────── ① 沙箱预览 ─────────

const F1 = {
  id: 'f1', name: '探针页.html', icon: '📦', description: '',
  isApp: false, size: 8, createdAt: 1, updatedAt: 1
} as SandboxFileMeta
const F2 = {
  id: 'f2', name: '另一页.html', icon: '📦', description: '',
  isApp: false, size: 9, createdAt: 1, updatedAt: 1
} as SandboxFileMeta

type Impl = (...a: any[]) => unknown
const sandboxStubs = (over: Record<string, Impl> = {}): Record<string, Impl> => ({
  listSandboxFiles: () => [F1, F2],
  getSandboxFile: (id: string) => ({ meta: { ...F1, id }, html: `<p>${id}</p>` }),
  deleteSandboxFile: () => ({ ok: true }),
  updateSandboxMeta: () => ({}),
  createSandboxFile: () => ({ ok: true }),
  ...over
})

const mountSandbox = (over: Record<string, Impl> = {}) => {
  stubPocketai(sandboxStubs(over))
  mountWithProviders(<SandboxModule />)
  return waitFor(() => expect(screen.queryByText('探针页.html')).toBeTruthy())
}

describe('① 沙箱预览那一发：三种到货要分得开', () => {
  it('回 {ok:false} ⇒ 不崩（屏上仍有内容）、原因上屏、预览区回到空态', async () => {
    await mountSandbox({ getSandboxFile: () => ({ ok: false, error: 'SANDBOX_GET:文件树读不到' }) })
    fireEvent.click(screen.getByText('探针页.html'))
    // 这一条是立项理由：旧写法在这里抛 preview.meta.isApp TypeError，整屏被卸载
    await waitFor(() => expect(bodyText().length).toBeGreaterThan(0))
    expect(bodyText()).toContain('SANDBOX_GET:文件树读不到')
    expect(bodyText()).toContain(L('sandbox.previewEmpty'))
    // 列表还在（这一发失败不该把整个模块带走）
    expect(screen.getByText('另一页.html')).toBeTruthy()
  })

  it('先读到、再点另一行而那一发失败 ⇒ 上一份预览必须退场（陈旧内容比空白更会骗人）', async () => {
    let fail = false
    await mountSandbox({
      getSandboxFile: (id: string) => {
        if (fail) return { ok: false, error: 'SANDBOX_GET:第二发读不到' }
        return { meta: { ...F1, id }, html: `<p>${id}</p>` }
      }
    })
    fireEvent.click(screen.getByText('探针页.html'))
    await waitFor(() => expect(screen.queryByTitle('探针页.html')).toBeTruthy())
    fail = true
    fireEvent.click(screen.getByText('另一页.html'))
    await waitFor(() => expect(bodyText()).toContain('SANDBOX_GET:第二发读不到'))
    expect(screen.queryByTitle('探针页.html'), '上一个文件的预览还挂着＝把旧的演成新的').toBeNull()
    expect(bodyText()).toContain(L('sandbox.previewEmpty'))
  })

  it('反向对照：读到 ⇒ 预览 iframe 在，屏上没有「读不到」', async () => {
    await mountSandbox()
    fireEvent.click(screen.getByText('探针页.html'))
    await waitFor(() => expect(screen.queryByTitle('探针页.html')).toBeTruthy())
    expect(bodyText()).not.toContain('读不到')
    expect(bodyText()).not.toContain(L('sandbox.previewEmpty'))
  })

  it('回 null（文件真没了）⇒ 仍是既有那句「文件不存在」，不混进"读不到"这一档', async () => {
    await mountSandbox({ getSandboxFile: () => null })
    fireEvent.click(screen.getByText('探针页.html'))
    await waitFor(() => expect(bodyText()).toContain(L('sandbox.fileMissing')))
    expect(bodyText()).not.toContain('读不到')
  })

  it('reject 面（通道真抛）⇒ 与 resolve 的失败对象同一张脸，且不留下未处理 rejection', async () => {
    const onReject = (): void => { throw new Error('不该有未处理 rejection：openPreview 要自己接住') }
    process.on('unhandledRejection', onReject)
    try {
      await mountSandbox({ getSandboxFile: () => Promise.reject(new Error('沙箱通道炸了')) })
      fireEvent.click(screen.getByText('探针页.html'))
      await waitFor(() => expect(bodyText()).toContain('沙箱通道炸了'))
      expect(bodyText()).toContain(L('sandbox.previewEmpty'))
      expect(screen.getByText('另一页.html')).toBeTruthy()
    } finally {
      process.off('unhandledRejection', onReject)
    }
  })
})

// ───────── ② WebDAV 配置那一发 ─────────

const CFG = { url: 'https://dav.example.com/backups', username: 'me', passwordCipher: 'x', directory: '/b' }
const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }

const mountBackup = (over: Record<string, Impl> = {}): void => {
  stubPocketai({
    loadWebDAVConfig: () => CFG,
    getBackupSchedule: () => SCHED,
    listWebDAVBackups: () => [],
    saveWebDAVConfig: (c: unknown) => ({ ok: true, cfg: c }),
    ...over
  })
  mountWithProviders(<BackupPanel enc={null} />)
}

describe('② WebDAV 配置那一读：三种到货要分得开', () => {
  it('回 {ok:false} ⇒ 那句常驻，而"已配置"那两块一律不出现，输入框也不许变 uncontrolled', async () => {
    mountBackup({ loadWebDAVConfig: () => ({ ok: false, error: 'WEBDAV_CFG:配置文件读不到' }) })
    await waitFor(() => expect(alerts()).toContain(L('common.loadFailed').replace('{msg}', 'WEBDAV_CFG:配置文件读不到')))
    expect(bodyText()).not.toContain(L('bk.syncCard'))
    expect(bodyText()).not.toContain(L('bk.uploadBtn'))
    const url = document.querySelector('input[placeholder="https://dav.example.com/..."]') as HTMLInputElement
    expect(url.value).toBe('')
    expect(url.hasAttribute('value')).toBe(true)
    expect(consoleErrors.join('\n')).not.toContain('changing a controlled input to be uncontrolled')
  })

  it('回 null（真的还没配置）⇒ 没有「读不到」那句，也没有同步卡——两种空要分得开', async () => {
    mountBackup({ loadWebDAVConfig: () => null })
    await waitFor(() => expect(screen.queryByText(L('bk.webdavTitle'))).toBeTruthy())
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain(L('bk.syncCard'))
  })

  it('反向对照：读到 ⇒ 同步卡与上传那一块照常出现，屏上没有「读不到」', async () => {
    mountBackup()
    await waitFor(() => expect(bodyText()).toContain(L('bk.syncCard')))
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain('读不到')
  })

  it('读不到之后用户当场填好存进去 ⇒ 那句必须退场（陈旧谎报不能留着）', async () => {
    mountBackup({
      loadWebDAVConfig: () => ({ ok: false, error: 'WEBDAV_CFG:配置文件读不到' })
    })
    await waitFor(() => expect(alerts()).toHaveLength(1))
    // 读不到 ⇒ 表单是空的，"保存"这一支本身要求 URL 与用户名都填过（§216 那条闸门在位）
    const url = document.querySelector('input[placeholder="https://dav.example.com/..."]') as HTMLInputElement
    fireEvent.change(url, { target: { value: 'https://dav.example.com/backups' } })
    const inputs = Array.from(document.querySelectorAll('input.input')) as HTMLInputElement[]
    fireEvent.change(inputs[1]!, { target: { value: 'me' } })
    fireEvent.click(screen.getByText(L('bk.saveCfg')))
    await waitFor(() => expect(bodyText()).toContain(L('bk.syncCard')))
    expect(alerts()).toEqual([])
  })

  it('reject 面 ⇒ 同一句用抛出的原文，那块"已配置"照旧不出现', async () => {
    mountBackup({ loadWebDAVConfig: () => Promise.reject(new Error('备份配置通道炸了')) })
    await waitFor(() => expect(alerts()).toContain(L('common.loadFailed').replace('{msg}', '备份配置通道炸了')))
    expect(bodyText()).not.toContain(L('bk.syncCard'))
  })
})

// §301 盘 B140 时补：上面 ② 只把 getBackupSchedule 固定桩成成功（`mountBackup` 的默认 SCHED）、
// 断的是 WebDAV 配置那一读的失败。§251 给"备份计划读失败"补的那张脸——`SettingsModule.tsx:1246`
// `!schedule && schedErr && <LoadFailNotice/>`（失败时那块不许整块消失、要说"读不到"）此前没有真挂载用例，
// 只有 §251 接线计数的源码级判据。BackupPanel 早已为真挂载而 export（:215 那条计数就是钉这个），
// 这里就着同一个 `mountBackup` 把这张脸补成行为用例。
describe('§301 备份计划那一读失败：那块不许整块消失', () => {
  it('getBackupSchedule 回 {ok:false} ⇒ 那句"读不到"常驻，不把计划演成"没这回事"', async () => {
    mountBackup({ getBackupSchedule: () => ({ ok: false, error: 'SCHED:计划读不到' }) })
    await waitFor(() =>
      expect(alerts()).toContain(L('common.loadFailed').replace('{msg}', 'SCHED:计划读不到'))
    )
  })

  it('reject 面 ⇒ 同一句用抛出的原文', async () => {
    mountBackup({ getBackupSchedule: () => Promise.reject(new Error('备份计划通道炸了')) })
    await waitFor(() =>
      expect(alerts()).toContain(L('common.loadFailed').replace('{msg}', '备份计划通道炸了'))
    )
  })

  it('反向对照：读到 ⇒ 没有那句"读不到"、屏上零 alert（计划那块照常摆出来）', async () => {
    mountBackup()
    await waitFor(() => expect(bodyText()).toContain(L('bk.webdavTitle')))
    expect(alerts()).toEqual([])
    expect(bodyText()).not.toContain('读不到')
  })
})

// ───────── ③ 接线计数 ─────────

describe('③ 接线计数', () => {
  const blankComments = (code: string): string =>
    code
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1}${' '.repeat(_m.length - p1.length - 1)}`)
  const read = (rel: string): string =>
    blankComments(fs.readFileSync(path.resolve(__dirname, '../', rel), 'utf-8').replace(/\r\n/g, '\n'))
  const SANDBOX = read('src/renderer/src/modules/sandbox/SandboxModule.tsx')
  const SETTINGS = read('src/renderer/src/modules/settings/SettingsModule.tsx')
  const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length

  it('两处"只判真值"的形状归零，各有 hasIpcFailed 在前', () => {
    expect(count(SANDBOX, /const r = await window\.pocketai\.getSandboxFile\(id\)\n\s*if \(r\) \{/g), '旧的 if (r)').toBe(0)
    // §326 在这一屏又收了两个消费点（设为应用／保存元数据），都写成同一形状 ⇒ 1 变 3
    expect(count(SANDBOX, /if \(hasIpcFailed\(r\)\) \{/g), '失败面先判').toBe(3)
    expect(count(SETTINGS, /loadWebDAVConfig\(\)\.then\(\(c\) => \{\n\s*if \(c\) \{/g), '旧的 if (c)').toBe(0)
    expect(count(SETTINGS, /if \(hasIpcFailed\(c\)\) \{/g)).toBe(1)
    expect(count(SETTINGS, /\.catch\(reportIpcError\('settings\.loadWebDAVConfig'\)\)/g), '裸交出去那一形归零').toBe(0)
  })

  it('那句"读不到"要真渲染在 WebDAV 表单里，且只在还没配上配置时', () => {
    expect(count(SETTINGS, /const \[wdCfgUnread, setWdCfgUnread\] = useState/g)).toBe(1)
    // §354：那一支从"一句独占一行"改成"那句＋同级那颗键"的同一份 JSX ⇒ 字面锚点从 `<div className="mb-2"><LoadFailNotice`
    // 挪到块首（判据要指的还是同一件事：只在 `!cfg` 时挂那张脸，且脸真在屏上）
    expect(
      count(SETTINGS, /\{!cfg && wdCfgUnread && \(\s*<div[\s\S]{0,140}?<LoadFailNotice/g),
      '空态让位＋常驻（§354 起这一支是"那句＋同级那颗键"）'
    ).toBe(1)
    expect(count(SETTINGS, /export const BackupPanel/), '导出只为真挂载').toBe(1)
  })
})
