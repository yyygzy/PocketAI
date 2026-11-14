// @vitest-environment jsdom
// P1-4 截图进对话（第一刀：Windows 当前窗口 / 整屏）
//
// 现场（逐行读过才写）：
//  · 捕获在主进程 `src/main/screenshot.ts`（PowerShell + PrintWindow），这里是它的**可测面**：
//    HWND / display_id 与 desktopCapturer source id 的匹配、文件名、data URL 真实字节数、
//    Windows 平台闸门，以及三条已启用快捷键的重复判定（`shared/popup-config.ts`）。
//  · 截图**不另建发送通路**：主进程把图规整成 ChatAttachment 塞进 PopupPayload，渲染层只往
//    既有附件栏里追加（可见、可删），发送仍走原来的 sendMessage(attachments)。
//    所以这里钉的是「载荷注入 → 缩略图出现 → × 可删 → 未点发送就没有 IPC」。
//  · 失败不静默：失败原因码经载荷 / 📷 入口返回值回到浮窗，按静态四语键上屏；
//    空载荷（不了之）与"错误提示永远挂着"两边都判。
//  · 真机捕获（PrintWindow/DWM 裁边/HiDPI 裁切）不在 jsdom 能力范围内，见本批汇报里的
//    "已验证 / 未验证" 清单，不在这里假装绿。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, screen, waitFor, cleanup } from '@testing-library/react'
import { mountWithProviders, stubPocketai, pocketaiCalls } from './helpers/renderer'
import { PopupApp } from '../src/renderer/src/popup/PopupApp'
import { PopupPanel } from '../src/renderer/src/modules/settings/SettingsModule'
import { zh } from '../src/renderer/src/i18n/zh'
import {
  findScreenSourceId,
  findWindowSourceId,
  isScreenshotPlatformSupported,
  screenshotDataUrlBytes,
  screenshotFileName,
  SCREENSHOT_MAX_BYTES
} from '../src/shared/screenshot'
import { popupAccelConflict } from '../src/shared/popup-config'
import type { ChatAttachment, PopupConfig, PopupPayload } from '../src/shared/types'

const L = (key: string): string => (zh as unknown as Record<string, string>)[key]!
const BUDGET = { timeout: 15_000, interval: 50 }

const PROVIDER = {
  id: 'p1', type: 'openai-compatible', name: 'PROVIDER',
  baseUrl: 'https://example.invalid/v1', apiKeys: [], models: ['m1'], enabled: true, createdAt: 1
}
const ASSISTANT = { id: 'a1', name: '通用问答', isBuiltin: true }

const SHOT: ChatAttachment = {
  type: 'image',
  name: 'moxia-window-20261114-153012.png',
  mimeType: 'image/png',
  size: 1024,
  data: 'data:image/png;base64,QUJD'
}

let pushers: Array<(p: PopupPayload) => void> = []

/** 浮窗桩：pull 显式传入；push 通道记下回调用于验证同一份载荷不重复上屏 */
function stubPopup(pull: PopupPayload | null, over: Record<string, (...a: any[]) => unknown> = {}): void {
  pushers = []
  stubPocketai({
    listProviders: () => [PROVIDER],
    listAssistants: () => [ASSISTANT],
    getPopupPayload: () => pull,
    onPopupPayload: (cb: (p: PopupPayload) => void) => {
      pushers.push(cb)
      return () => { pushers = pushers.filter((x) => x !== cb) }
    },
    onChatChunk: () => () => {},
    onChatDone: () => () => {},
    onChatError: () => () => {},
    createConversation: () => ({ id: 'cv1' }),
    sendMessage: () => Promise.resolve({ ok: true }),
    abortChat: () => ({ ok: true }),
    hidePopup: () => ({ ok: true }),
    fetchModels: () => ['m1'],
    ...over
  })
}

const deliver = async (p: PopupPayload): Promise<void> => {
  await act(async () => { pushers.forEach((cb) => cb(p)) })
}

const shotCount = (): number => screen.queryAllByAltText(SHOT.name).length

beforeEach(() => {
  window.localStorage.clear()
  // jsdom 没实现 Element.scrollTo（浮窗自动滚到底会调），补空实现（§204 同款）
  ;(Element.prototype as unknown as { scrollTo: () => void }).scrollTo = () => {}
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('P1-4 ① 截图作为附件进浮窗：可见、可删、未发送就还在本机', () => {
  it('载荷带图 ⇒ 缩略图上屏；× 能删掉；全程没有 sendMessage', async () => {
    stubPopup({ mode: 'quick', screenshot: SHOT, ts: 100 })
    mountWithProviders(<PopupApp />)

    const img = await screen.findByAltText(SHOT.name, {}, BUDGET)
    expect(img.getAttribute('src')).toBe(SHOT.data)

    const removeBtn = img.parentElement?.querySelector('button')
    expect(removeBtn, '附件缩略图旁边要能删').not.toBeNull()
    fireEvent.click(removeBtn!)

    await waitFor(() => expect(screen.queryByAltText(SHOT.name)).toBeNull())
    expect(pocketaiCalls().some((c) => c.fn === 'sendMessage'), '截图不许自发送').toBe(false)
  })

  it('同一份载荷被 pull＋push 各投一次 ⇒ 只出现一张（幂等判据覆盖截图）', async () => {
    const payload: PopupPayload = { mode: 'quick', screenshot: SHOT, ts: 101 }
    stubPopup(payload)
    mountWithProviders(<PopupApp />)

    await screen.findByAltText(SHOT.name, {}, BUDGET)
    await deliver(payload)
    await act(async () => { await new Promise((r) => setTimeout(r, 0)) })
    expect(shotCount(), '重复投递不该叠第二张').toBe(1)
  })
})

describe('P1-4 ② 失败原因上屏（不静默），新载荷会收掉旧错误', () => {
  it('no-window ⇒ 一句可读原因', async () => {
    stubPopup({ mode: 'quick', screenshotError: 'no-window', ts: 200 })
    mountWithProviders(<PopupApp />)

    const alert = await screen.findByTestId('popup-capture-error', {}, BUDGET)
    expect(alert.getAttribute('role')).toBe('alert')
    expect(alert.textContent).toContain(L('popup.capture.err.noWindow'))
    expect(shotCount()).toBe(0)
  })

  it('后续普通快捷问答载荷把失败提示收掉（不许常驻）', async () => {
    stubPopup({ mode: 'quick', screenshotError: 'permission', ts: 201 })
    mountWithProviders(<PopupApp />)

    await screen.findByTestId('popup-capture-error', {}, BUDGET)
    await deliver({ mode: 'quick', ts: 202 })
    await waitFor(() => expect(screen.queryByTestId('popup-capture-error')).toBeNull())
  })
})

describe('P1-4 ③ 浮窗内 📷 入口：同一条附件链路，目标二选一', () => {
  it('选「整个屏幕」⇒ 向主进程要 screen，结果追加进附件栏', async () => {
    stubPopup(null, {
      captureScreenshot: (target: string) => ({
        ok: true, target, width: 1280, height: 720, attachment: SHOT
      })
    })
    mountWithProviders(<PopupApp />)

    fireEvent.click(await screen.findByTestId('popup-capture', {}, BUDGET))
    fireEvent.click(await screen.findByTestId('popup-capture-screen', {}, BUDGET))

    await screen.findByAltText(SHOT.name, {}, BUDGET)
    const calls = pocketaiCalls().filter((c) => c.fn === 'captureScreenshot')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args[0]).toBe('screen')
  })

  it('主进程回「权限被拒」⇒ 原因上屏，附件栏不动', async () => {
    stubPopup(null, { captureScreenshot: () => ({ ok: false, code: 'permission' }) })
    mountWithProviders(<PopupApp />)

    fireEvent.click(await screen.findByTestId('popup-capture', {}, BUDGET))
    fireEvent.click(await screen.findByTestId('popup-capture-window', {}, BUDGET))

    const alert = await screen.findByTestId('popup-capture-error', {}, BUDGET)
    expect(alert.textContent).toContain(L('popup.capture.err.permission'))
    expect(shotCount()).toBe(0)
  })
})

describe('P1-4 ④ 设置页：第三行开关与平台差异说明', () => {
  const cfg = (over: Partial<PopupConfig> = {}): PopupConfig => ({
    quickEnabled: true,
    selectionEnabled: false,
    screenshotEnabled: true,
    quickAccelerator: 'CommandOrControl+Shift+Space',
    selectionAccelerator: 'CommandOrControl+Shift+U',
    screenshotAccelerator: 'CommandOrControl+Alt+S',
    screenshotSupported: true,
    ...over
  })

  it('不支持的平台 ⇒ 那句平台说明在，开关禁用（不给假出口）', async () => {
    stubPocketai({ getPopupConfig: () => cfg({ screenshotSupported: false, screenshotEnabled: false }) })
    mountWithProviders(<PopupPanel />)

    const note = await screen.findByTestId('set-popup-screenshot-platform-hint', {}, BUDGET)
    expect(note.textContent).toContain(L('popup.screenshotPlatformNote').slice(0, 12))
    const switches = screen.getAllByRole('switch')
    expect(switches).toHaveLength(3)
    expect((switches[2] as HTMLButtonElement).disabled, '第三行＝截图').toBe(true)
  })

  it('Windows 支持 ⇒ 不出现那句，开关可用', async () => {
    stubPocketai({ getPopupConfig: () => cfg() })
    mountWithProviders(<PopupPanel />)

    await screen.findByText(L('popup.screenshotTitle'), {}, BUDGET)
    expect(screen.queryByTestId('set-popup-screenshot-platform-hint')).toBeNull()
    const switches = screen.getAllByRole('switch')
    expect((switches[2] as HTMLButtonElement).disabled).toBe(false)
  })
})

describe('P1-4 ⑤ 纯判定：source 匹配 / 文件名 / 字节数 / 三键冲突', () => {
  it('平台闸门只放行 Windows', () => {
    expect(isScreenshotPlatformSupported('win32')).toBe(true)
    expect(isScreenshotPlatformSupported('darwin')).toBe(false)
    expect(isScreenshotPlatformSupported('linux')).toBe(false)
  })

  it('window source 按 HWND 全等匹配，不做字符串包含', () => {
    const ids = ['window:123:0', 'window:1234:0', 'screen:0:0']
    expect(findWindowSourceId(123, ids)).toBe('window:123:0')
    expect(findWindowSourceId(999, ids)).toBeNull()
    // HWND=0 是"没有前台窗口"，不许匹配到任何 source
    expect(findWindowSourceId(0, ['window:0:0'])).toBeNull()
  })

  it('screen source 先按 display_id 精确匹配，匹配不到退第一个', () => {
    const sources = [
      { id: 'screen:0:0', displayId: '1' },
      { id: 'screen:1:0', displayId: '2' }
    ]
    expect(findScreenSourceId('2', sources)).toBe('screen:1:0')
    expect(findScreenSourceId('9', sources)).toBe('screen:0:0')
    expect(findScreenSourceId('1', [])).toBeNull()
  })

  it('文件名按本地时间与目标命名', () => {
    expect(screenshotFileName('window', new Date(2026, 10, 14, 15, 30, 12))).toBe(
      'moxia-window-20261114-153012.png'
    )
    expect(screenshotFileName('screen', new Date(2026, 0, 2, 3, 4, 5), 'jpg')).toBe(
      'moxia-screen-20260102-030405.jpg'
    )
  })

  it('data URL 字节数按 base64 折算（10MB 上限要按真实字节判）', () => {
    expect(screenshotDataUrlBytes('data:image/png;base64,')).toBe(0)
    expect(screenshotDataUrlBytes('data:image/png;base64,QUJD')).toBe(3)
    expect(screenshotDataUrlBytes('data:image/png;base64,AA==')).toBe(1)
    expect(SCREENSHOT_MAX_BYTES).toBe(10 * 1024 * 1024)
  })

  it('三键冲突：只算已启用的；关掉的重复不算；空串不参与', () => {
    const base = {
      quickEnabled: true,
      selectionEnabled: true,
      screenshotEnabled: true,
      quickAccelerator: 'CommandOrControl+Shift+Space',
      selectionAccelerator: 'CommandOrControl+Shift+U',
      screenshotAccelerator: 'CommandOrControl+Alt+S'
    }
    expect(popupAccelConflict(base)).toBeNull()
    expect(popupAccelConflict({ ...base, screenshotAccelerator: 'CommandOrControl+Shift+U' })).toBe(
      'CommandOrControl+Shift+U'
    )
    // 截图开关关着 ⇒ 它和选区撞了也不算冲突
    expect(
      popupAccelConflict({
        ...base, screenshotEnabled: false, screenshotAccelerator: 'CommandOrControl+Shift+U'
      })
    ).toBeNull()
    // 首尾空白先 trim 再比
    expect(
      popupAccelConflict({ ...base, screenshotAccelerator: ' CommandOrControl+Shift+Space ' })
    ).toBe('CommandOrControl+Shift+Space')
    expect(
      popupAccelConflict({ ...base, screenshotAccelerator: '' })
    ).toBeNull()
  })
})
