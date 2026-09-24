// gateway-base 错误脱敏与消息分片测试
//
// 覆盖 src/main/channels/gateway-base.ts 的两个纯函数：
// - safeError：从错误消息中剥离 bot token / API Key / URL 等敏感信息
// - splitMessage：按长度分片（优先在换行处切，避免硬切）
//
// 策略：纯函数，模块仅 import 类型，直接测试。
import { describe, it, expect } from 'vitest'
import { safeError, splitMessage } from '../src/main/channels/gateway-base'

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
