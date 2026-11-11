// 模型输出结构化契约层测试：
// 合法 / 代码块 / 前后解释 / 缺失必填 / 字段非法 / 未知字段 / 不可解析 /
// 修复一次成功 / 修复后仍失败 / 修复轮抛错 / 只调用两次 / 原文截断
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import {
  generateStructured,
  extractJson,
  describeStructuredError,
  type StructuredOutputError
} from '../src/main/agent/structured-output'

const schema = z.strictObject({
  title: z.string(),
  count: z.number().optional()
})

describe('generateStructured — 合法输出', () => {
  it('直接是 JSON 时一次通过，不再修复', async () => {
    const generate = vi.fn(async () => '{"title":"你好"}')
    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ title: '你好' })
    expect(result.attempts).toBe(1)
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith(null)
  })

  it('markdown 代码块 / 前后带解释文字也能提取', async () => {
    const fenced = vi.fn(async () => '说明如下\n```json\n{"title":"你好"}\n```\n结束')
    const r1 = await generateStructured({ schema, generate: fenced })
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.data.title).toBe('你好')

    const prose = vi.fn(async () => '好的：{"title":"你好","count":2} 以上。')
    const r2 = await generateStructured({ schema, generate: prose })
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.data).toEqual({ title: '你好', count: 2 })
  })
})

describe('generateStructured — 缺失与非法分开报', () => {
  it('必填字段缺失 → MISSING_FIELD，修复一次成功后返回第二份数据', async () => {
    const generate = vi
      .fn<(repair: StructuredOutputError | null) => Promise<string>>()
      .mockResolvedValueOnce('{}')
      .mockResolvedValueOnce('{"title":"补上了"}')

    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.title).toBe('补上了')
    expect(result.attempts).toBe(2)
    expect(generate).toHaveBeenCalledTimes(2)

    const repair = generate.mock.calls[1]?.[0]
    expect(repair?.stage).toBe('SCHEMA')
    expect(repair?.issues[0]).toMatchObject({ code: 'MISSING_FIELD', path: 'title' })
  })

  it('字段类型非法 → INVALID_FIELD，修复后仍失败', async () => {
    const generate = vi.fn(async () => '{"title":123}')
    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.stage).toBe('SCHEMA')
      expect(result.error.issues[0]).toMatchObject({ code: 'INVALID_FIELD', path: 'title' })
      expect(result.error.issues[0]?.message).not.toContain('缺少')
    }
    expect(result.attempts).toBe(2)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('strict schema 的未知字段 → 逐 key 报 INVALID_FIELD（不允许编造）', async () => {
    const generate = vi.fn(async () => '{"title":"你好","extra":1}')
    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'INVALID_FIELD', path: 'extra' })
      )
    }
  })

  it('非 strict schema 允许额外字段：多余字段被忽略，不触发修复', async () => {
    const loose = z.object({ title: z.string() })
    const generate = vi.fn(async () => '{"title":"你好","extra":1}')
    const result = await generateStructured({ schema: loose, generate })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toEqual({ title: '你好' })
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('optional 字段缺失是允许的，不报错', async () => {
    const generate = vi.fn(async () => '{"title":"你好"}')
    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data.count).toBeUndefined()
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('嵌套路径能定位到具体段：queries[0].title / queries[0].name', async () => {
    const nested = z.strictObject({
      queries: z.array(z.strictObject({ title: z.string() }))
    })
    const generate = vi.fn(async () => '{"queries":[{"name":"x"}]}')
    const result = await generateStructured({ schema: nested, generate })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'MISSING_FIELD', path: 'queries[0].title' })
      )
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ code: 'INVALID_FIELD', path: 'queries[0].name' })
      )
    }
  })
})

describe('generateStructured — 不可解析与修复边界', () => {
  it('提取不出 JSON → UNPARSEABLE，issues 为空并带 parseError', async () => {
    const generate = vi.fn(async () => '我觉得都挺相关的')
    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.stage).toBe('UNPARSEABLE')
      expect(result.error.issues).toEqual([])
      expect(result.error.parseError).toBeTruthy()
    }
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('修复轮抛错 → 保留首轮校验错误，并带上 repairError', async () => {
    const generate = vi
      .fn<(repair: StructuredOutputError | null) => Promise<string>>()
      .mockResolvedValueOnce('{}')
      .mockRejectedValueOnce(new Error('network down'))

    const result = await generateStructured({ schema, generate })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.issues[0]?.code).toBe('MISSING_FIELD')
      expect(result.repairError).toContain('network down')
    }
    expect(result.attempts).toBe(2)
  })

  it('首轮抛错原样交给调用方（调用失败不是输出不合规）', async () => {
    await expect(
      generateStructured({
        schema,
        generate: async () => {
          throw new Error('boom')
        }
      })
    ).rejects.toThrow('boom')
  })

  it('最多只调用两次，不会循环修复', async () => {
    const generate = vi.fn(async () => '不是 JSON')
    await generateStructured({ schema, generate })
    expect(generate).toHaveBeenCalledTimes(2)
  })
})

describe('generateStructured — 原文截断与错误描述', () => {
  it('错误里的 raw 按 maxRawChars 截断并说明原文长度', async () => {
    const generate = vi.fn(async () => 'x'.repeat(1000))
    const result = await generateStructured({ schema, generate, maxRawChars: 50 })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.raw.startsWith('x'.repeat(50))).toBe(true)
      expect(result.error.raw).toContain('截断')
      expect(result.error.raw).toContain('1000')
    }
  })

  it('describeStructuredError 带路径与缺失/非法区分，并限制展示条数', () => {
    const error: StructuredOutputError = {
      code: 'BAD_OUTPUT',
      stage: 'SCHEMA',
      issues: [
        { code: 'MISSING_FIELD', path: 'title', message: '必填字段缺失' },
        { code: 'INVALID_FIELD', path: 'count', message: 'expected number' },
        { code: 'INVALID_FIELD', path: 'extra', message: 'schema 未声明的字段' },
        { code: 'INVALID_FIELD', path: 'other', message: 'schema 未声明的字段' },
        { code: 'INVALID_FIELD', path: 'more', message: 'schema 未声明的字段' }
      ],
      raw: '{}'
    }
    const text = describeStructuredError(error)

    expect(text).toContain('title 缺少必填字段')
    expect(text).toContain('count 字段非法')
    expect(text).toContain('等 5 项')
  })
})

describe('extractJson', () => {
  it('空文本 / 无 JSON → 失败', () => {
    expect(extractJson('')).toMatchObject({ ok: false })
    expect(extractJson('   ')).toMatchObject({ ok: false })
    expect(extractJson('没有结构')).toMatchObject({ ok: false })
  })

  it('字符串里的括号不影响平衡扫描', () => {
    const result = extractJson('前言 {"a":"这里有个 } 和 ]","b":[1,2]} 后记')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toEqual({ a: '这里有个 } 和 ]', b: [1, 2] })
  })
})
