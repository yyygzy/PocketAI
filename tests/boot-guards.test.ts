// boot-guards 加载重试测试（V4-Iter-456）
//
// 背景：2026-11-08 真机注入（只杀 NetworkService、保住渲染进程）始终走不到 5s 快探针，
// 最终只有 45s 显示兜底生效。事后定位到 did-stop-loading 会在页面未提交时（getURL() 仍为空）
// 被 Chromium 补发一次，旧实现无条件 clearTimers()，把探针与挂起阈值一起清掉。
// 黑盒注入无法稳定卡在「加载停了但没提交」这个窗口里，改用假事件流做确定性覆盖。
//
// 覆盖四条断言：
// ① 不 emit 任何事件 → 5s 后探针命中，只重发一次导航；
// ② did-start-navigation（主框架）之后 → 探针不再出现；
// ③ did-stop-loading 且 URL 为空（页面没提交）→ 计时保留，探针仍然命中；
// ④ did-stop-loading 且 URL 非空（页面已提交）→ 两个计时器都清掉，不重发。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

const mocks = vi.hoisted(() => ({
  /** createLogger('boot') 收到的每条日志：level + 拼好的文本 */
  logs: [] as Array<{ level: 'debug' | 'info' | 'warn' | 'error'; text: string }>,
  showMessageBoxCalls: 0,
  isPackaged: false
}))

vi.mock('../src/main/logger', () => {
  const push = (level: 'debug' | 'info' | 'warn' | 'error') => (...args: unknown[]) => {
    mocks.logs.push({ level, text: args.filter((a) => typeof a === 'string').join(' ') })
  }
  return {
    createLogger: () => ({
      debug: push('debug'),
      info: push('info'),
      warn: push('warn'),
      error: push('error')
    })
  }
})

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged
    },
    getAppPath: () => 'C:\\PocketAI'
  },
  dialog: {
    showMessageBox: () => {
      mocks.showMessageBoxCalls++
    }
  },
  BrowserWindow: class {}
}))

import { installLoadRetry } from '../src/main/windows/boot-guards'

type LoadRetryTarget = Parameters<typeof installLoadRetry>[0]

/** 假窗口：webContents 是 EventEmitter，getURL 读可控的 url 字段 */
function makeWindow(urls: { current: string }) {
  const webContents = Object.assign(new EventEmitter(), {
    getURL: () => urls.current,
    isLoading: () => false
  })
  const win = Object.assign(new EventEmitter(), {
    webContents,
    isDestroyed: () => false,
    isVisible: () => false,
    show: () => {},
    focus: () => {}
  })
  return { win: win as unknown as LoadRetryTarget, webContents, urls }
}

function messages(level?: 'debug' | 'info' | 'warn' | 'error'): string[] {
  return mocks.logs.filter((l) => !level || l.level === level).map((l) => l.text)
}

const PROBE_WARN = '导航 5s 内未开始（请求未被派发）'

describe('installLoadRetry：加载重试与探针判据', () => {
  let reload: ReturnType<typeof vi.fn<() => void>>

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.logs.length = 0
    mocks.showMessageBoxCalls = 0
    reload = vi.fn<() => void>()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('① 不 emit 任何事件：5s 后探针命中，只重发一次导航', () => {
    const { win } = makeWindow({ current: '' })
    installLoadRetry(win, '解锁窗口', reload)

    vi.advanceTimersByTime(5_001)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(messages('warn').some((m) => m.includes(PROBE_WARN))).toBe(true)
  })

  it('② did-start-navigation（主框架）之后：探针不再出现', () => {
    const { win, webContents } = makeWindow({ current: '' })
    installLoadRetry(win, '解锁窗口', reload)

    vi.advanceTimersByTime(1_000)
    webContents.emit('did-start-navigation', {}, 'http://localhost:5173/', false, true)

    // 跨过 5s 探针点（累计 6s），挂起阈值 30s 还没到
    vi.advanceTimersByTime(5_000)

    expect(reload).not.toHaveBeenCalled()
    expect(messages('warn').some((m) => m.includes(PROBE_WARN))).toBe(false)
  })

  it('③ did-stop-loading 且 URL 为空（页面没提交）：计时保留，探针仍然命中', () => {
    const { win, webContents } = makeWindow({ current: '' })
    installLoadRetry(win, '解锁窗口', reload)

    // 真实形态：加载开始后 Chromium 在页面未提交时补发一次 did-stop-loading
    webContents.emit('did-start-loading')
    webContents.emit('did-stop-loading')

    vi.advanceTimersByTime(5_001)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(messages('warn').some((m) => m.includes(PROBE_WARN))).toBe(true)
  })

  it('④ did-stop-loading 且 URL 非空（页面已提交）：清掉探针与挂起阈值，不重发', () => {
    const urls = { current: '' }
    const { win, webContents } = makeWindow(urls)
    installLoadRetry(win, '解锁窗口', reload)

    webContents.emit('did-start-navigation', {}, 'http://localhost:5173/', false, true)
    webContents.emit('did-start-loading')
    urls.current = 'http://localhost:5173/'
    webContents.emit('did-stop-loading')

    // 跨过 5s 探针与 30s 挂起阈值：两个计时器都应已清掉
    vi.advanceTimersByTime(60_000)

    expect(reload).not.toHaveBeenCalled()
    expect(messages('warn')).toEqual([])
  })
})
