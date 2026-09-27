// gateway-base 错误脱敏与消息分片测试
//
// 覆盖 src/main/channels/gateway-base.ts 的两个纯函数：
// - safeError：从错误消息中剥离 bot token / API Key / URL 等敏感信息
// - splitMessage：按长度分片（优先在换行处切，避免硬切）
//
// 策略：纯函数，模块仅 import 类型，直接测试。
import { describe, it, expect } from 'vitest'
import {
  safeError,
  splitMessage,
  sanitizeIncoming,
  MAX_INCOMING_TEXT_CHARS,
  MAX_INCOMING_ID_CHARS,
  MAX_INCOMING_NAME_CHARS
} from '../src/main/channels/gateway-base'

// ── safeError ────────────────────────────────────────────
describe('safeError — 错误消息脱敏', () => {
  it('普通错误 → method: name: message', () => {
    const err = new TypeError('参数非法')
    expect(safeError(err, 'sendMessage')).toBe('sendMessage: TypeError: 参数非法')
  })

  it('含 bot token (bot123:xxx) → 脱敏为通用消息', () => {
    const err = new Error('请求 https://api.telegram.org/bot123:ABCDEF/sendMessage 失败')
    expect(safeError(err, 'sendMessage')).toBe('sendMessage 请求失败（网络或凭证错误）')
  })

  it('含 Slack token (xoxb-) → 脱敏', () => {
    const err = new Error('xoxb-1234567890-abcdef 无效')
    expect(safeError(err, 'postMessage')).toBe('postMessage 请求失败（网络或凭证错误）')
  })

  it('含 http URL → 脱敏', () => {
    const err = new Error('连接 http://192.168.1.1:8080 超时')
    expect(safeError(err, 'getMe')).toBe('getMe 请求失败（网络或凭证错误）')
  })

  it('含 https URL → 脱敏', () => {
    const err = new Error('请求 https://discord.com/api/v10 401')
    expect(safeError(err, 'sendMessage')).toBe('sendMessage 请求失败（网络或凭证错误）')
  })

  it('含 discord.com/api → 脱敏', () => {
    const err = new Error('discord.com/api 返回 403')
    expect(safeError(err, 'send')).toBe('send 请求失败（网络或凭证错误）')
  })

  it('非 Error 对象（字符串）→ String 化后处理', () => {
    expect(safeError('普通错误', 'send')).toBe('send: 普通错误')
  })

  it('非 Error 含敏感模式 → 脱敏', () => {
    expect(safeError('bot999:secret-leaked', 'send')).toBe('send 请求失败（网络或凭证错误）')
  })

  it('无敏感信息的对象 → String 化', () => {
    expect(safeError(42, 'send')).toBe('send: 42')
  })
})

// ── splitMessage ─────────────────────────────────────────
describe('splitMessage — 消息分片', () => {
  it('长度 <= limit → 单元素数组原样', () => {
    expect(splitMessage('hello', 10)).toEqual(['hello'])
  })

  it('长度 === limit → 单元素数组', () => {
    expect(splitMessage('hello', 5)).toEqual(['hello'])
  })

  it('在换行处切分（不硬切）', () => {
    const text = 'aaaa\nbbbb\ncccc'
    // limit=5: 第一片找 lastIndexOf('\n', 4) → index 4 → 'aaaa'，rest='bbbb\ncccc'
    // 第二片 limit=5: lastIndexOf('\n', 4) → 4 → 'bbbb'，rest='cccc'
    expect(splitMessage(text, 5)).toEqual(['aaaa', 'bbbb', 'cccc'])
  })

  it('换行位置 < limit*0.5 → 硬切到 limit', () => {
    const text = 'aaaaaaaaa\nbbbb'
    // limit=5: lastIndexOf('\n', 4) → 找不到(换行在9) → cut=-1 < floor(5*0.5)=2 → cut=5
    expect(splitMessage(text, 5)[0]).toBe('aaaaa')
  })

  it('无换行 → 硬切到 limit', () => {
    const text = 'aaaaaaaaaa'
    expect(splitMessage(text, 4)).toEqual(['aaaa', 'aaaa', 'aa'])
  })

  it('切分后去除开头换行', () => {
    const text = 'aaaa\n\nbbbb'
    const result = splitMessage(text, 5)
    // rest='\nbbbb' → replace(/^\n+/, '') → 'bbbb'
    expect(result).toEqual(['aaaa', 'bbbb'])
  })

  it('空串 → [""]', () => {
    expect(splitMessage('', 5)).toEqual([''])
  })

  it('多行多片', () => {
    const text = '1\n2\n3\n4\n5'
    // limit=3: 每片尝试在换行处切
    const result = splitMessage(text, 3)
    // 所有片拼回应等于原文本（除了可能的开头换行被去）
    expect(result.join('\n')).toBe(text)
  })
})

// ── sanitizeIncoming ─────────────────────────────────────
describe('sanitizeIncoming — 入站消息统一收口', () => {
  const valid = { chatId: 'c1', userId: 'u1', text: 'hello', firstName: 'Tom' }

  it('合法消息原样返回（text 被 trim）', () => {
    expect(sanitizeIncoming(valid)).toEqual({
      chatId: 'c1',
      userId: 'u1',
      text: 'hello',
      firstName: 'Tom'
    })
  })

  it('text 前后空白被 trim', () => {
    expect(sanitizeIncoming({ ...valid, text: '  hi  ' })?.text).toBe('hi')
  })

  it('firstName 缺失/非字符串 → 空串', () => {
    expect(sanitizeIncoming({ chatId: 'c', userId: 'u', text: 't' })?.firstName).toBe('')
    expect(
      sanitizeIncoming({ chatId: 'c', userId: 'u', text: 't', firstName: 123 })?.firstName
    ).toBe('')
    expect(
      sanitizeIncoming({ chatId: 'c', userId: 'u', text: 't', firstName: null })?.firstName
    ).toBe('')
  })

  it('chatId 缺失/非字符串非数字 → null', () => {
    expect(sanitizeIncoming({ userId: 'u', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: '', userId: 'u', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: '   ', userId: 'u', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: {}, userId: 'u', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: true, userId: 'u', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: null, userId: 'u', text: 't' })).toBeNull()
  })

  it('userId 缺失/非法 → null', () => {
    expect(sanitizeIncoming({ chatId: 'c', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: 'c', userId: [], text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: 'c', userId: {}, text: 't' })).toBeNull()
  })

  it('数字型 id 接受并 String 化（Telegram 风格）', () => {
    const r = sanitizeIncoming({ chatId: 123456789, userId: 987654321, text: 't' })
    expect(r?.chatId).toBe('123456789')
    expect(r?.userId).toBe('987654321')
  })

  it('NaN/Infinity id 拒绝', () => {
    expect(sanitizeIncoming({ chatId: NaN, userId: 'u', text: 't' })).toBeNull()
    expect(sanitizeIncoming({ chatId: Infinity, userId: 'u', text: 't' })).toBeNull()
  })

  it('id 前后空白被 trim', () => {
    expect(sanitizeIncoming({ chatId: ' c ', userId: 'u', text: 't' })?.chatId).toBe('c')
  })

  it('text 非字符串/空串/纯空白 → null', () => {
    expect(sanitizeIncoming({ chatId: 'c', userId: 'u', text: 42 })).toBeNull()
    expect(sanitizeIncoming({ chatId: 'c', userId: 'u', text: null })).toBeNull()
    expect(sanitizeIncoming({ chatId: 'c', userId: 'u', text: {} })).toBeNull()
    expect(sanitizeIncoming({ chatId: 'c', userId: 'u', text: '' })).toBeNull()
    expect(sanitizeIncoming({ chatId: 'c', userId: 'u', text: '   ' })).toBeNull()
  })

  it(`text 超过 ${MAX_INCOMING_TEXT_CHARS} 字符 → 截断并附提示`, () => {
    const long = 'a'.repeat(MAX_INCOMING_TEXT_CHARS + 500)
    const r = sanitizeIncoming({ chatId: 'c', userId: 'u', text: long })
    expect(r).not.toBeNull()
    expect(r!.text.length).toBeLessThan(long.length)
    expect(r!.text.startsWith('a'.repeat(MAX_INCOMING_TEXT_CHARS))).toBe(true)
    expect(r!.text.endsWith('（消息过长已截断）')).toBe(true)
  })

  it('text 恰好等于上限 → 原样不截断', () => {
    const exact = '字'.repeat(MAX_INCOMING_TEXT_CHARS)
    const r = sanitizeIncoming({ chatId: 'c', userId: 'u', text: exact })
    expect(r?.text).toBe(exact)
  })

  it(`chatId 超过 ${MAX_INCOMING_ID_CHARS} 字符 → 硬截断无提示`, () => {
    const long = 'x'.repeat(MAX_INCOMING_ID_CHARS + 100)
    const r = sanitizeIncoming({ chatId: long, userId: 'u', text: 't' })
    expect(r?.chatId).toBe('x'.repeat(MAX_INCOMING_ID_CHARS))
  })

  it(`userId 超过 ${MAX_INCOMING_ID_CHARS} 字符 → 硬截断`, () => {
    const long = 'y'.repeat(MAX_INCOMING_ID_CHARS + 50)
    const r = sanitizeIncoming({ chatId: 'c', userId: long, text: 't' })
    expect(r?.userId).toBe('y'.repeat(MAX_INCOMING_ID_CHARS))
  })

  it(`firstName 超过 ${MAX_INCOMING_NAME_CHARS} 字符 → 截断`, () => {
    const long = '名'.repeat(MAX_INCOMING_NAME_CHARS + 30)
    const r = sanitizeIncoming({ chatId: 'c', userId: 'u', text: 't', firstName: long })
    expect(r?.firstName).toBe('名'.repeat(MAX_INCOMING_NAME_CHARS))
  })

  it('firstName 前后空白被 trim', () => {
    expect(
      sanitizeIncoming({ chatId: 'c', userId: 'u', text: 't', firstName: '  Jerry  ' })?.firstName
    ).toBe('Jerry')
  })

  it('返回新对象，不复用入站引用', () => {
    const r = sanitizeIncoming(valid)
    expect(r).not.toBe(valid)
  })
})
