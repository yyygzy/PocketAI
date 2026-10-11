// MCP 调用记录的预览文本（写库前脱敏 + 截断）
//
// 这张表要长期留在 app.db 里，而 none 模式下 app.db 是明文；MCP 工具的入参常常就带密钥
// （server 的 API key 参数、Authorization 头），结果正文也可能回显密钥。
// 所以这里断言的是「原值绝不出现在预览里」，不是「格式对不对」。
import { describe, it, expect } from 'vitest'
import {
  summarizeMcpArgs,
  summarizeMcpResult,
  summarizeMcpError,
  redactStrings,
  MCP_CALL_ARGS_PREVIEW_CHARS,
  MCP_CALL_RESULT_PREVIEW_CHARS
} from '../src/main/mcp/call-summary'

describe('summarizeMcpArgs', () => {
  it('普通入参拼成 k=v', () => {
    expect(summarizeMcpArgs({ url: 'https://a.test', limit: 5 })).toBe('url="https://a.test", limit=5')
  })

  it('敏感键名整值替换，原值一个字符都不留', () => {
    const out = summarizeMcpArgs({ api_key: 'sk-live-abcdef123456', q: '天气' })!
    expect(out).toContain('api_key=[redacted]')
    expect(out).not.toContain('sk-live-abcdef123456')
    expect(out).toContain('q="天气"')
  })

  it('嵌套对象里的敏感键同样被替换（只靠一层键名拦不住）', () => {
    const out = summarizeMcpArgs({ headers: { Authorization: 'Bearer abcdef123456789' } })!
    expect(out).not.toContain('abcdef123456789')
  })

  it('单值超长就地截断，整串再受总长上限', () => {
    const out = summarizeMcpArgs({ text: 'x'.repeat(5000) })!
    expect(out.length).toBeLessThanOrEqual(MCP_CALL_ARGS_PREVIEW_CHARS)
    expect(out).toContain('…')
  })

  it('空对象 / null / undefined 不产出占位串（没什么可记就不记）', () => {
    expect(summarizeMcpArgs({})).toBeNull()
    expect(summarizeMcpArgs(null)).toBeNull()
    expect(summarizeMcpArgs(undefined)).toBeNull()
  })

  it('非对象入参（异常调用）也能出一行且被截断', () => {
    const out = summarizeMcpArgs('boom'.repeat(500))!
    expect(out.length).toBeLessThanOrEqual(MCP_CALL_ARGS_PREVIEW_CHARS)
  })
})

describe('summarizeMcpResult', () => {
  it('MCP 内容块取 text 并用 | 拼接', () => {
    expect(summarizeMcpResult({ content: [{ type: 'text', text: '北京 晴' }, { type: 'text', text: '24℃' }] })).toBe(
      '北京 晴 | 24℃'
    )
  })

  it('非文本块只标类型，不把 base64 图片塞进库里', () => {
    const out = summarizeMcpResult({ content: [{ type: 'image', data: 'A'.repeat(5000) }] })!
    expect(out).toBe('[image]')
    expect(out).not.toContain('AAAA')
  })

  it('结果正文里回显的密钥被掩掉（自由文本没有键名可依赖）', () => {
    const out = summarizeMcpResult({ content: [{ type: 'text', text: 'token=sk-abcdef123456789 and sk-another123456' }] })!
    expect(out).not.toContain('abcdef123456789')
    expect(out).not.toContain('another123456')
    expect(out).toContain('[redacted]')
  })

  it('超长结果按上限截断，不整段存档', () => {
    const out = summarizeMcpResult({ content: [{ type: 'text', text: 'y'.repeat(50_000) }] })!
    expect(out.length).toBeLessThanOrEqual(MCP_CALL_RESULT_PREVIEW_CHARS + 2)
    expect(out).toContain('…')
  })

  it('非数组 content / 其它形状整体序列化', () => {
    expect(summarizeMcpResult({ foo: 1 })).toContain('foo')
    expect(summarizeMcpResult('plain')).toBe('plain')
    expect(summarizeMcpResult(null)).toBeNull()
  })
})

describe('summarizeMcpError / redactStrings', () => {
  it('Error 收成 "name: message" 并限长', () => {
    const e = new Error('E'.repeat(2000))
    e.name = 'McpTransportError'
    const out = summarizeMcpError(e)!
    expect(out.startsWith('McpTransportError: E')).toBe(true)
    expect(out.length).toBeLessThanOrEqual(300)
  })

  it('非 Error 抛出物也不丢', () => {
    expect(summarizeMcpError('socket hang up')).toBe('socket hang up')
    expect(summarizeMcpError(null)).toBeNull()
  })

  it('redactStrings 覆盖三种常见形态：键值、裸 sk-/pk-、Bearer 头', () => {
    expect(redactStrings('api_key: ABCDEF123456')).toBe('api_key=[redacted]')
    expect(redactStrings('key=sk-abcdefgh12345678')).toBe('key=[redacted]')
    expect(redactStrings('use sk-abcdefgh12345678 please')).toBe('use [redacted] please')
    expect(redactStrings('Authorization: Bearer abcdef123456789xyz')).toBe('Authorization=[redacted]')
  })

  it('普通文本不误伤（别把排障要看的字打成码）', () => {
    expect(redactStrings('连接超时 30s，server 未响应')).toBe('连接超时 30s，server 未响应')
  })
})
