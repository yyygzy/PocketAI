// 日志脱敏与长串封顶（src/main/security/log-redact.ts）
//
// 覆盖：敏感键名整值替换（含嵌套/数组）、非敏感键不误伤、长串截断带原长、
// Error/Date/Buffer/Map 的处理策略、循环引用与深度上限。
// 单独成模块正是为了绕开 logger.ts 顶层的 electron 依赖，直接测纯逻辑。
import { describe, it, expect } from 'vitest'
import {
  capLogString,
  redactLogValue,
  MAX_LOG_STRING_CHARS,
  REDACTED_PLACEHOLDER
} from '../src/main/security/log-redact'

const plain = (v: unknown): Record<string, unknown> => redactLogValue(v) as Record<string, unknown>

describe('redactLogValue — 敏感键名', () => {
  it('常见凭据键名整值替换', () => {
    for (const key of [
      'authorization',
      'Authorization',
      'apiKey',
      'api_key',
      'token',
      'clientSecret',
      'password',
      'passwd',
      'credential',
      'cookie',
      'privateKey',
      'accessKey',
      'sessionId'
    ]) {
      const out = plain({ [key]: 'super-secret-value' })
      expect(out[key], key).toBe(REDACTED_PLACEHOLDER)
    }
  })

  it('嵌套对象与数组元素内的敏感键也替换', () => {
    const out = plain({
      provider: { name: 'openai', apiKeys: ['sk-1'] },
      headers: [{ Authorization: 'Bearer x' }, { 'X-Trace': 'ok' }],
      cfg: { nested: { token: 't', keep: 'k' } }
    }) as {
      provider: Record<string, unknown>
      headers: Array<Record<string, unknown>>
      cfg: { nested: Record<string, unknown> }
    }
    expect(out.provider.name).toBe('openai')
    // 键名命中 → 整个值（这里是数组）被替换，而不是逐项脱敏
    expect(out.provider.apiKeys).toBe(REDACTED_PLACEHOLDER)
    expect(out.headers[0]!.Authorization).toBe(REDACTED_PLACEHOLDER)
    expect(out.headers[1]!['X-Trace']).toBe('ok')
    expect(out.cfg.nested.token).toBe(REDACTED_PLACEHOLDER)
    expect(out.cfg.nested.keep).toBe('k')
  })

  it('值本身不含敏感信息但键名命中 → 仍替换；键名不含敏感词 → 保留', () => {
    const out = plain({ NOTE: 'just text', TOKEN_HINT: 'x' }) as Record<string, unknown>
    expect(out.NOTE).toBe('just text')
    expect(out.TOKEN_HINT).toBe(REDACTED_PLACEHOLDER)
  })

  it('不改动原始对象（返回副本）', () => {
    const src = { password: 'p' }
    plain(src)
    expect(src.password).toBe('p')
  })
})

describe('redactLogValue — 特殊类型策略', () => {
  it('Error 转成 stack 字符串（并保持截断规则）', () => {
    const err = new Error('boom')
    const out = plain({ e: err }) as { e: string }
    expect(typeof out.e).toBe('string')
    expect(out.e).toContain('boom')
  })

  it('Date / Buffer / Map / Set 原样保留（交给 inspect 格式化）', () => {
    const d = new Date(0)
    const buf = Buffer.from('x')
    const map = new Map([['a', 'b']])
    const set = new Set(['a'])
    const out = plain({ d, buf, map, set }) as Record<string, unknown>
    expect(out.d).toBe(d)
    expect(out.buf).toBe(buf)
    expect(out.map).toBe(map)
    expect(out.set).toBe(set)
  })

  it('循环引用替换为 [Circular]，不死递归', () => {
    const a: Record<string, unknown> = { name: 'a' }
    a.self = a
    expect((plain(a) as { self: unknown }).self).toBe('[Circular]')
  })

  it('第 4 层不再展开（与 inspect(depth:4) 对齐）', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: { password: 'p' } } } } } }
    const out = plain(deep) as { l1: { l2: { l3: { l4: unknown } } } }
    expect(out.l1.l2.l3.l4).toBe('[depth-limit]')
    // 浅一层仍在范围内
    const shallower = plain({ l1: { l2: { l3: { password: 'p' } } } }) as {
      l1: { l2: { l3: Record<string, unknown> } }
    }
    expect(shallower.l1.l2.l3.password).toBe(REDACTED_PLACEHOLDER)
  })

  it('标量与 null 原样返回', () => {
    expect(redactLogValue(null)).toBeNull()
    expect(redactLogValue(42)).toBe(42)
    expect(redactLogValue(true)).toBe(true)
    expect(redactLogValue(undefined)).toBeUndefined()
  })
})

describe('capLogString', () => {
  it('上限内原样返回', () => {
    const s = 'x'.repeat(MAX_LOG_STRING_CHARS)
    expect(capLogString(s)).toBe(s)
  })

  it('超长截断并标注原长（SEC-14 的主路径：整段模型回复不落盘）', () => {
    const long = 'y'.repeat(MAX_LOG_STRING_CHARS + 5000)
    const out = capLogString(long)
    expect(out.length).toBeLessThan(MAX_LOG_STRING_CHARS + 40)
    expect(out).toContain('已截断')
    expect(out).toContain(String(long.length))
    expect(out).not.toContain('y'.repeat(MAX_LOG_STRING_CHARS + 1))
  })

  it('嵌套结构里的长字符串同样封顶', () => {
    const out = plain({ reply: 'z'.repeat(MAX_LOG_STRING_CHARS + 100) }) as { reply: string }
    expect(out.reply.length).toBeLessThan(MAX_LOG_STRING_CHARS + 40)
  })
})
