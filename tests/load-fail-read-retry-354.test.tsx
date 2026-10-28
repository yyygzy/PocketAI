// @vitest-environment jsdom
// V4-Iter-354：「读不到」那张脸的**第三档**——那一发的读写原来写在挂载 effect 体内联 `.then` 里，
// 根本没有具名 loader ⇒ 按§350 的尺子先抽 loader（行为逐字不变），再在同级配一颗 `agent.retryRead`。
//
// 这一批五处（名单与分诊账写在闸门 `load-fail-read-retry-gate-350.test.ts` 头部＋`data/tmp/roster-354.txt`）：
//   · 智能标题那一发：读不到时那颗开关只是 `disabled`，而 `toggle` 只写不读 ⇒ 这一支同屏没有出口；
//   · 浮窗快捷键配置：早退 return＝整块面板（含捕获／保存）换成那一句，形状同 §352 的加密面板；
//   · WebDAV 配置：`!cfg` 时同步卡片与那颗「刷新」（重的是**文件清单**、不是配置）整块不出现，
//     「保存」会把这份没人认领的空表单写回去＝假出口还会盖掉远端那份；
//   · 更新信息：读在**父页**，面板是 props 驱动的早退脸 ⇒ 键只能喊父级递下来的 `onReloadInfo`；
//   · 对话页侧栏的活跃／归档／分组：一份 `reloadConversations` 重拉三份，**三句配三颗键**（§351 会话栏先例），
//     出口逐条回读过——换助手／删会话那些 onClick 里确实也有它，但都带副作用，不算"这一屏命令得动的重读"。
// 每处三条：①那句与那颗键同屏、键在 `role="alert"` 盒子**外面**（§268）；②按下去真再发一发（或真喊到父级那一次）；
// ③到货后那句当场收回、脸换成本体。反向对照：还在加载那一支（早退给「加载中…」）不许有那颗键。
// 页脚那处（`getPaths`）的落点在 SettingsModule 页本体，现挂整页要预置十几条通道 ⇒ 只有闸门看得见，账落清单 B200。
import { describe, it, expect, beforeAll } from 'vitest'
import { fireEvent, screen, waitFor, act } from '@testing-library/react'
import { mountWithProviders, calledFns, stubPocketai } from './helpers/renderer'
import {
  BackupPanel,
  ConversationSettingsPanel,
  PopupPanel,
  UpdatePanel
} from '../src/renderer/src/modules/settings/SettingsModule'
import { ConversationList } from '../src/renderer/src/modules/chat/ConversationList'
import { zh } from '../src/renderer/src/i18n/zh'
import type {
  ConversationRecord,
  PopupConfig,
  UpdateEvent,
  UpdateInfo,
  WebDAVBackupFile
} from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const FAILED = (msg: string): string => L('common.loadFailed').replace('{msg}', msg)
const NAMED = (what: string, msg: string): string =>
  L('common.loadFailedNamed').replace('{what}', what).replace('{msg}', msg)
const RETRY = L('agent.retryRead')
const alerts = (): string[] => screen.queryAllByRole('alert').map((e) => (e.textContent ?? '').trim())
const settle = (): Promise<void> => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const callsOf = (fn: string): number => calledFns().filter((f) => f === fn).length
const FAIL = { ok: false, error: '库被占用' }
const LIST_KEYS = ['conv-list-read-retry', 'archived-list-read-retry', 'groups-list-read-retry']

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom 没有布局 */
  }
})

// 同名通道的到货队列（§330 的口径：单槽会被后到的顶掉）
let q: Record<string, Array<(v: unknown) => void>>
const pend = (key: string): Promise<unknown> =>
  new Promise<unknown>((resolve) => {
    ;(q[key] ??= []).push(resolve)
  })
const answer = (key: string, v: unknown): void => {
  const queue = q[key] ?? []
  q[key] = []
  queue.forEach((resolve) => resolve(v))
}

// ─────────────── ① 智能标题那一发（本批把读写从挂载 effect 体内联抽成 `loadEnabled`） ───────────────
describe('对话设置·智能标题：读不到 ⇒ 那颗开关只是 disabled（点它只写不读），这一支得自带出口', () => {
  it('失败脸有键、键在 alert 外面 ⇒ 按下去真再发一发 getSmartTitleEnabled ⇒ 到货后那句与那颗键一起撤', async () => {
    q = {}
    stubPocketai({ getSmartTitleEnabled: () => pend('title') })
    mountWithProviders(<ConversationSettingsPanel />)
    await waitFor(() => expect(callsOf('getSmartTitleEnabled')).toBe(1))
    answer('title', FAIL)
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('smart-title-read-retry')
    expect(key.textContent).toBe(RETRY)
    expect(alerts()[0]).not.toContain(RETRY)

    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getSmartTitleEnabled')).toBe(2))
    answer('title', true)
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('smart-title-read-retry')).toBeNull()
    expect(screen.getByRole('switch')).toBeTruthy()
  })

  it('反向对照：还在加载那一支（那一发没回来）既没有那句也没有那颗键', async () => {
    q = {}
    stubPocketai({ getSmartTitleEnabled: () => pend('title') })
    mountWithProviders(<ConversationSettingsPanel />)
    await waitFor(() => expect(callsOf('getSmartTitleEnabled')).toBe(1))
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('smart-title-read-retry')).toBeNull()
    answer('title', false)
    await settle()
  })
})

// ─────────────── ② 浮窗快捷键配置那一发（抽成 `loadPopupCfg`） ───────────────
describe('设置页·浮窗配置：早退 return 把整块面板换成那一句 ⇒ 捕获／保存那两颗键都不在屏上', () => {
  const CFG: PopupConfig = {
    quickEnabled: true,
    selectionEnabled: false,
    quickAccelerator: 'CommandOrControl+Shift+P',
    selectionAccelerator: ''
  }
  it('失败脸有键 ⇒ 按下去真再发一发 ⇒ 到货后那句收回、也不再停在「加载中」', async () => {
    let fail = true
    stubPocketai({ getPopupConfig: () => (fail ? FAIL : CFG), setPopupConfig: () => ({ ok: true }) })
    mountWithProviders(<PopupPanel />)
    await waitFor(() => expect(callsOf('getPopupConfig')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('popup-cfg-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('getPopupConfig')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('popup-cfg-read-retry')).toBeNull()
    expect(screen.queryByText(L('common.loading'))).toBeNull()
  })
})

// ─────────────── ③ WebDAV 配置那一发（抽成 `reloadCfg`） ───────────────
describe('设置页·备份：配置读不到 ⇒ 同步卡片与那颗「刷新」整块不出现，而「保存」会把这份空表单写回去', () => {
  const CFG = { url: 'https://dav.example.com/old', username: 'me', passwordCipher: 'x', directory: '/b' }
  const SCHED = { enabled: false, intervalHours: 24, retentionCount: 7, nextRunAt: null, lastRunAt: null }
  const FILE: WebDAVBackupFile = {
    name: 'pocketai-full-2026-10-25.zip', size: 1024, mtime: 1, encrypted: false, kind: 'full'
  }
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

  it('失败脸有键 ⇒ 按下去真多发一发 loadWebDAVConfig ⇒ 到货后那句收回、库地址回填进表单', async () => {
    let fail = true
    mountBackup({ loadWebDAVConfig: () => (fail ? FAIL : CFG) })
    await waitFor(() => expect(callsOf('loadWebDAVConfig')).toBe(1))
    await settle()
    expect(alerts()).toEqual([FAILED('库被占用')])
    const key = screen.getByTestId('webdav-cfg-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)
    // 那颗「刷新」（重的是文件清单）此时根本不在屏上——它当不了这一发的出口
    expect(screen.queryByText(L('bk.refresh'))).toBeNull()

    fail = false
    fireEvent.click(key)
    await waitFor(() => expect(callsOf('loadWebDAVConfig')).toBe(2))
    await settle()
    await waitFor(() => expect(alerts()).toEqual([]))
    expect(screen.queryByTestId('webdav-cfg-read-retry')).toBeNull()
    expect((screen.getByPlaceholderText('https://dav.example.com/...') as HTMLInputElement).value).toBe(CFG.url)
  })
})

// ─────────────── ④ 更新信息那一发（读在父页，靠 props 递下来的 `onReloadInfo`） ───────────────
describe('设置页·更新：props 驱动的早退脸 ⇒ 那颗键只能喊父页重取，面板自己没有这一发的读', () => {
  const IDLE = { status: 'idle' } as unknown as UpdateEvent

  it('有原因 ⇒ 那句旁边一颗键、按下去 onReloadInfo 一次一发；info 在场时那颗键不存在', () => {
    let n = 0
    stubPocketai({})
    const view = mountWithProviders(
      <UpdatePanel info={null} err="更新源不可达" status={IDLE} onReloadInfo={() => { n++ }} />
    )
    expect(alerts()).toEqual([FAILED('更新源不可达')])
    const key = screen.getByTestId('update-info-read-retry')
    expect(alerts()[0]).not.toContain(RETRY)
    // 整块面板（那颗「检查更新」）此刻不在屏上
    expect(screen.queryByText(L('upd.checkBtn'))).toBeNull()

    fireEvent.click(key)
    fireEvent.click(key)
    expect(n).toBe(2)

    // 反向对照：同一颗组件在数据在场时不渲染这张脸，也就不该有那颗键
    view.unmount()
    stubPocketai({})
    mountWithProviders(
      <UpdatePanel
        info={{ isPackaged: true, currentVersion: '1.2.8', autoUpdateEnabled: false } as unknown as UpdateInfo}
        err={null}
        status={IDLE}
        onReloadInfo={() => { n++ }}
      />
    )
    expect(alerts()).toEqual([])
    expect(screen.queryByTestId('update-info-read-retry')).toBeNull()
    expect(n).toBe(2)
  })
})

// ─────────────── ⑤ 对话页侧栏那三份清单（一发重拉三份 ⇒ 三句配三颗键） ───────────────
describe('对话页侧栏：活跃／归档／分组三份读各说各的，也各配一颗键（§351 会话栏先例）', () => {
  const conv = (id: string): ConversationRecord =>
    ({ id, title: id, assistantId: 'asst-default', createdAt: 1, updatedAt: 1 }) as unknown as ConversationRecord
  type Impl = (...a: unknown[]) => unknown

  const mount = (props: Record<string, unknown>, stubs: Record<string, Impl> = {}, onReloadLists = (): void => {}): void => {
    stubPocketai({ getDraft: () => '', setDraft: () => ({ ok: true }), searchMessages: () => [], ...stubs })
    mountWithProviders(
      <ConversationList
        conversations={[]}
        currentId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onDelete={() => {}}
        groups={[]}
        onReloadLists={onReloadLists}
        {...props}
      />
    )
  }

  it('三份都没读到 ⇒ 三句各点自己的名、三颗键都在 alert 盒子外面 ⇒ 每颗按下去都真喊到那一次重拉', () => {
    let n = 0
    mount(
      {
        conversationsUnread: { error: '甲挂了' },
        archivedUnread: { error: '乙挂了' },
        groupsUnread: { error: '丙挂了' }
      },
      {},
      () => { n++ }
    )
    expect(alerts()).toEqual([
      NAMED(L('chat.conversationsList'), '甲挂了'),
      NAMED(L('chat.archivedList'), '乙挂了'),
      NAMED(L('chat.groupsList'), '丙挂了')
    ])
    for (const id of LIST_KEYS) {
      const k = screen.getByTestId(id)
      expect(k.textContent).toBe(RETRY)
    }
    // 键都在盒子外面：任何一句里都不许混进"重试"两个字（§268 的口径）
    expect(alerts().some((a) => a.includes(RETRY))).toBe(false)
    LIST_KEYS.forEach((id) => fireEvent.click(screen.getByTestId(id)))
    expect(n).toBe(3)
  })

  it('反向对照：三份都读到了 ⇒ 三颗键一颗都不在（键不是一张常驻的脸）', async () => {
    mount({ conversations: [conv('c1')] })
    await settle()
    for (const id of LIST_KEYS) expect(screen.queryByTestId(id)).toBeNull()
  })
})
