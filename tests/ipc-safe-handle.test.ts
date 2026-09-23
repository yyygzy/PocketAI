// 主进程 IPC 兜底设施 safeHandle 行为测试
// 契约：成功原样透传；同步抛/异步 reject 统一转 {ok:false,error}，
// 非 Error 抛出取「未知错误」；异常在主进程侧留 warn 日志；参数原样转发
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// 捕获 ipcMain.handle 注册的 listener（hoisted：mock 工厂不能引用普通顶层变量）
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, fn)
    }
  }
}))

import { safeHandle } from '../src/main/ipc/safe-handle'

const CH = 'test:channel'
const eventStub = { sender: {} }

const invoke = (...args: unknown[]) => mocks.handlers.get(CH)!(eventStub, ...args)

describe('safeHandle', () => {
  beforeEach(() => {
    mocks.handlers.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('成功返回值原样透传（含业务校验失败 {ok:false}）', async () => {
    safeHandle(CH, () => ({ ok: true as const, data: 1 }))
    await expect(invoke()).resolves.toEqual({ ok: true, data: 1 })

    safeHandle('test:biz', () => ({ ok: false as const, error: '参数非法' }))
    await expect(mocks.handlers.get('test:biz')!(eventStub)).resolves.toEqual({
      ok: false,
      error: '参数非法'
    })
  })

  it('event 与参数原样转发给 listener', async () => {
    const listener = vi.fn((_e: unknown, a: number, b: string) => ({ ok: true as const, sum: a + b.length }))
    safeHandle(CH, listener)
    await invoke(3, 'xy')
    expect(listener).toHaveBeenCalledWith(eventStub, 3, 'xy')
  })

  it('async listener reject(Error) → 结构化失败', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeHandle(CH, async () => {
      throw new Error('db locked')
    })
    await expect(invoke()).resolves.toEqual({ ok: false, error: 'db locked' })
    expect(warn).toHaveBeenCalled()
  })

  it('同步 throw 字符串 → 结构化失败且保留文本', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeHandle(CH, () => {
      // eslint-disable-next-line no-throw-literal
      throw '通道未就绪'
    })
    await expect(invoke()).resolves.toEqual({ ok: false, error: '通道未就绪' })
  })

  it('throw 非 Error 对象 → error 取默认兜底而非 undefined', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    safeHandle(CH, () => {
      throw { code: 500 }
    })
    await expect(invoke()).resolves.toEqual({ ok: false, error: '未知错误' })
  })

  it('listener 返回 Promise：resolved 值透传', async () => {
    safeHandle(CH, async () => ({ ok: true as const, data: await Promise.resolve('ok') }))
    await expect(invoke()).resolves.toEqual({ ok: true, data: 'ok' })
  })
})
