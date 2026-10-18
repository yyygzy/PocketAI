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

import { argsSchema, describeIssue, safeHandle } from '../src/main/ipc/safe-handle'
import { z } from 'zod'

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

describe('safeHandle — 入参校验文案（不再把 zod 英文甩给界面）', () => {
  it('默认英文文案被翻译，且去掉 invalid args 前缀', async () => {
    safeHandle(
      CH,
      () => ({ ok: true as const }),
      argsSchema(z.object({ name: z.string().min(1), type: z.enum(['a', 'b']) }))
    )
    const r = (await invoke({ name: '', type: 'x' })) as { ok: false; error: string }
    expect(r.ok).toBe(false)
    expect(r.error).toContain('名称至少需要 1 个字符')
    expect(r.error).toContain('类型取值不在允许范围内（可选：a / b）')
    expect(r.error).not.toContain('Too small')
    expect(r.error).not.toContain('invalid args')
  })

  it('schema 里自定义过的中文 message 原样保留', async () => {
    safeHandle(CH, () => ({ ok: true as const }), argsSchema(z.string().min(1, '文本不能为空')))
    const r = (await invoke('')) as { error: string }
    expect(r.error).toBe('文本不能为空')
  })

  it('映射不到的字段名显示原 key（猜个中文名更容易误导）', async () => {
    safeHandle(CH, () => ({ ok: true as const }), argsSchema(z.object({ weirdKey: z.string().max(3) })))
    const r = (await invoke({ weirdKey: 'abcdef' })) as { error: string; ipcCode?: string; ipcArgs?: string }
    // V4-Iter-209 之后回码另开字段：error 永远是那句人话（137 处 toast.error＋21 处 ipcFailText 直接显示它，不许退化成回码），
    // ipcCode/ipcArgs 只给走 ipcFailureText 的那 5 处换四语用。
    expect(r.error).toBe('weirdKey过长，最多 3 个字符')
    expect(r.ipcCode).toBe('IPC_ARG_INVALID')
    expect(r.ipcArgs).toBe('weirdKey=too_big=string=3')
  })

  it('数值/数组的 too_small·too_big 按 origin 出话；未知 code 回落通用文案', () => {
    const issue = (o: Record<string, unknown>) => o as unknown as z.ZodIssue
    expect(describeIssue(issue({ code: 'too_small', origin: 'number', minimum: 0, path: ['opacity'], message: 'Too small' }))).toBe(
      'opacity不能小于 0' // 映射表里没有的字段保留原 key，不编中文名
    )
    expect(
      describeIssue(issue({ code: 'too_big', origin: 'array', maximum: 50, path: ['apiKeys'], message: 'Too big' }))
    ).toBe('API Key最多 50 项')
    expect(describeIssue(issue({ code: 'custom', path: ['x'], message: 'some english detail' }))).toBe('x不符合要求')
    expect(describeIssue(issue({ code: 'invalid_type', expected: 'string', path: [], message: 'Invalid input' }))).toBe(
      '参数类型不对（应为 string）'
    )
    expect(describeIssue(issue({ code: 'invalid_format', format: 'url', path: ['baseUrl'], message: 'Invalid URL' }))).toBe(
      'Base URL格式不正确'
    )
  })
})
