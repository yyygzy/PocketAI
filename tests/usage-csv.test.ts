// 用量明细 CSV 构建纯函数测试
// 覆盖 src/renderer/src/utils/usage-csv.ts：
// - csvCell：逗号/双引号/CRLF 转义（RFC 4180）
// - formatLocalTime：本地时区固定格式
// - buildUsageCsv：BOM/表头列序/行数/null 助手/空明细
import { describe, it, expect } from 'vitest'
import { csvCell, formatLocalTime, buildUsageCsv } from '../src/renderer/src/utils/usage-csv'
import type { UsageDetailItem } from '../src/shared/types'

const h = {
  time: '时间', conversation: '会话', assistant: '助手', provider: '服务商',
  model: '模型', prompt: '输入', completion: '输出', cached: '缓存', total: '总计', cost: '花费'
}

const item = (over: Partial<UsageDetailItem> = {}): UsageDetailItem => ({
  createdAt: new Date(2026, 9, 2, 15, 4, 5).getTime(),
  messageId: 'm1',
  conversationId: 'c1',
  conversationTitle: '测试会话',
  assistantId: 'a1',
  assistantName: '写作助手',
  provider: 'openai',
  model: 'gpt-4o',
  promptTokens: 100,
  completionTokens: 50,
  cachedTokens: 0,
  totalTokens: 150,
  cost: 0.0004,
  ...over
})

describe('csvCell', () => {
  it('普通值不加引号（数字转字符串）', () => {
    expect(csvCell(150)).toBe('150')
    expect(csvCell('openai')).toBe('openai')
  })
  it('含逗号双引号包裹', () => {
    expect(csvCell('你好,世界')).toBe('"你好,世界"')
  })
  it('含双引号：包裹且内部引号翻倍', () => {
    expect(csvCell('他说"嗨"')).toBe('"他说""嗨"""')
  })
  it('含换行/回车双引号包裹', () => {
    expect(csvCell('a\nb')).toBe('"a\nb"')
    expect(csvCell('a\rb')).toBe('"a\rb"')
  })
})

describe('formatLocalTime', () => {
  it('YYYY-MM-DD HH:mm:ss 且补零', () => {
    expect(formatLocalTime(new Date(2026, 0, 5, 3, 4, 5).getTime())).toBe('2026-01-05 03:04:05')
  })
})

describe('buildUsageCsv', () => {
  it('带 UTF-8 BOM 前缀（Excel 中文不乱码）', () => {
    expect(buildUsageCsv([], h).startsWith('\uFEFF')).toBe(true)
  })

  it('表头按固定 10 列顺序', () => {
    const csv = buildUsageCsv([], h)
    const firstLine = csv.replace('\uFEFF', '').split('\r\n')[0]
    expect(firstLine).toBe('时间,会话,助手,服务商,模型,输入,输出,缓存,总计,花费')
  })

  it('行尾使用 CRLF，空明细只有表头一行', () => {
    const csv = buildUsageCsv([], h)
    expect(csv.endsWith('\r\n')).toBe(true)
    expect(csv.replace('\uFEFF', '').trimEnd().split('\r\n')).toHaveLength(1)
  })

  it('明细字段成行，时间本地格式化，保持入参顺序不重排', () => {
    const csv = buildUsageCsv([item(), item({ createdAt: new Date(2026, 8, 1, 0, 0, 0).getTime(), model: 'gpt-4o-mini' })], h)
    const lines = csv.replace('\uFEFF', '').trimEnd().split('\r\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe('2026-10-02 15:04:05,测试会话,写作助手,openai,gpt-4o,100,50,0,150,0.0004')
    expect(lines[2]!.startsWith('2026-09-01 00:00:00')).toBe(true)
  })

  it('assistantName 为 null 时该列空串', () => {
    const csv = buildUsageCsv([item({ assistantId: null, assistantName: null })], h)
    const line = csv.replace('\uFEFF', '').trimEnd().split('\r\n')[1]
    expect(line).toBe('2026-10-02 15:04:05,测试会话,,openai,gpt-4o,100,50,0,150,0.0004')
  })

  it('标题含逗号/引号时按规则转义不破列', () => {
    const csv = buildUsageCsv([item({ conversationTitle: '周报, "Q3"' })], h)
    const line = csv.replace('\uFEFF', '').trimEnd().split('\r\n')[1]
    expect(line).toBe('2026-10-02 15:04:05,"周报, ""Q3""",写作助手,openai,gpt-4o,100,50,0,150,0.0004')
  })
})
