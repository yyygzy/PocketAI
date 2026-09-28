// builtin 工具聚合与 execute 测试
//
// 覆盖 src/main/tools/builtin.ts：
//  - BUILTIN_TOOLS 聚合：13 个 tool，id 集合
//  - timeNowTool.execute：无参/offset_days 偏移/非数字兜底
//  - calculatorTool.execute：正常表达式/空表达式/非法表达式
//  - webFetchTool.execute：mock safeFetch + 真 cheerio 解析小 HTML；空 url/非 http(s)/HTTP 非 2xx
//  - webSearchTool.execute：mock runWebSearch 返回 hits/空数组；空 query
//  - jsEvalTool.execute：mock runJsEval 透传；空 code
//
// 不重复测：safeMathEval（builtin-safematheval.test.ts 已覆盖 13 用例）。
// 不测：weatherTool（weather.test.ts 独立测）、calendarRead/kbSearch/todoWrite/memorySave/reminder（各有独立测试）。
//
// 策略：builtin.ts 顶层 import 重依赖链，全部 mock 为 stub（同 builtin-safematheval.test.ts 范式）；
//       webFetchTool 用真 cheerio（dependencies 已装）测小 HTML 解析。
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../src/main/tools/websearch', () => ({ runWebSearch: vi.fn() }))
vi.mock('../src/main/sandbox/js-eval-runner', () => ({ runJsEval: vi.fn() }))
vi.mock('../src/main/net/safe-fetch', () => ({ safeFetch: vi.fn() }))
vi.mock('../src/main/tools/weather', () => ({ weatherTool: { schema: { id: 'weather.query' }, execute: vi.fn() } }))
vi.mock('../src/main/tools/calendar-ics', () => ({ calendarReadTool: { schema: { id: 'calendar.read' }, execute: vi.fn() } }))
vi.mock('../src/main/tools/kb-search', () => ({ kbSearchTool: { schema: { id: 'kb_search' }, execute: vi.fn() } }))
vi.mock('../src/main/tools/todo-write', () => ({ todoWriteTool: { schema: { id: 'todo_write' }, execute: vi.fn() } }))
vi.mock('../src/main/tools/memory-save', () => ({ memorySaveTool: { schema: { id: 'memory_save' }, execute: vi.fn() } }))
vi.mock('../src/main/tools/reminder', () => ({
  reminderSetTool: { schema: { id: 'reminder.set' }, execute: vi.fn() },
  reminderListTool: { schema: { id: 'reminder.list' }, execute: vi.fn() },
  reminderCancelTool: { schema: { id: 'reminder.cancel' }, execute: vi.fn() }
}))

import { BUILTIN_TOOLS } from '../src/main/tools/builtin'
import { safeFetch } from '../src/main/net/safe-fetch'
import { runWebSearch } from '../src/main/tools/websearch'
import { runJsEval } from '../src/main/sandbox/js-eval-runner'

const mockSafeFetch = vi.mocked(safeFetch)
const mockRunWebSearch = vi.mocked(runWebSearch)
const mockRunJsEval = vi.mocked(runJsEval)

function findTool(id: string) {
  const t = BUILTIN_TOOLS.find((x) => x.schema.id === id)
  if (!t) throw new Error(`tool ${id} not in BUILTIN_TOOLS`)
  return t
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ── BUILTIN_TOOLS 聚合 ────────────────────────────────────

describe('BUILTIN_TOOLS 聚合', () => {
  it('含 13 个工具', () => {
    expect(BUILTIN_TOOLS).toHaveLength(13)
  })

  it('id 集合包含全部预期工具', () => {
    const ids = BUILTIN_TOOLS.map((t) => t.schema.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        'time.now', 'calculator', 'web.fetch', 'web.search', 'js.eval',
        'weather.query', 'calendar.read', 'kb_search', 'todo_write',
        'memory_save', 'reminder.set', 'reminder.list', 'reminder.cancel'
      ])
    )
  })

  it('每个 tool 有 schema + execute', () => {
    for (const t of BUILTIN_TOOLS) {
      expect(t.schema).toBeTruthy()
      expect(typeof t.execute).toBe('function')
    }
  })
})

// ── time.now ─────────────────────────────────────────────

describe('time.now execute', () => {
  const tool = findTool('time.now')

  it('无参数 → 返回当前时间，offset_days=0', async () => {
    const before = Date.now()
    const out = JSON.parse(await tool.execute({}))
    const after = Date.now()
    expect(out.offset_days).toBe(0)
    expect(out.timestamp).toBeGreaterThanOrEqual(before)
    expect(out.timestamp).toBeLessThanOrEqual(after)
    expect(out.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
    expect(out.local).toBeTruthy()
    expect(out.weekday).toMatch(/^星期[日一二三四五六]$/)
    expect(out.tz).toBeTruthy()
  })

  it('offset_days=100 → timestamp 接近 now + 100 天', async () => {
    const before = Date.now()
    const out = JSON.parse(await tool.execute({ offset_days: 100 }))
    const expectedMin = before + 100 * 86_400_000 - 1000
    const expectedMax = Date.now() + 100 * 86_400_000 + 1000
    expect(out.offset_days).toBe(100)
    expect(out.timestamp).toBeGreaterThanOrEqual(expectedMin)
    expect(out.timestamp).toBeLessThanOrEqual(expectedMax)
  })

  it('offset_days=-3 → 3 天前', async () => {
    const before = Date.now()
    const out = JSON.parse(await tool.execute({ offset_days: -3 }))
    expect(out.offset_days).toBe(-3)
    expect(out.timestamp).toBeLessThan(before)
  })

  it('offset_days 非数字 / NaN / Infinity → 当 0 处理', async () => {
    expect(JSON.parse(await tool.execute({ offset_days: 'abc' })).offset_days).toBe(0)
    expect(JSON.parse(await tool.execute({ offset_days: NaN })).offset_days).toBe(0)
    expect(JSON.parse(await tool.execute({ offset_days: Infinity })).offset_days).toBe(0)
  })
})

// ── calculator ───────────────────────────────────────────

describe('calculator execute', () => {
  const tool = findTool('calculator')

  it('正常表达式 → {expression, result}', async () => {
    const out = JSON.parse(await tool.execute({ expression: '2 + 3 * 4' }))
    expect(out.expression).toBe('2 + 3 * 4')
    expect(out.result).toBe(14)
  })

  it('空表达式 → 抛错', async () => {
    await expect(tool.execute({ expression: '' })).rejects.toThrow('expression 不能为空')
    await expect(tool.execute({ expression: '   ' })).rejects.toThrow('expression 不能为空')
  })

  it('非法表达式 → 抛错（走 safeMathEval）', async () => {
    await expect(tool.execute({ expression: 'process' })).rejects.toThrow('不允许的标识符')
  })
})

// ── web.fetch ────────────────────────────────────────────

describe('web.fetch execute', () => {
  const tool = findTool('web.fetch')

  const sampleHtml = `<!doctype html>
<html><head><title>测试页面</title></head>
<body>
  <nav>导航栏</nav>
  <script>var x=1</script>
  <main><article><p>这是正文内容，应当被抽取。</p></article></main>
  <footer>页脚</footer>
</body></html>`

  it('空 url → 抛错', async () => {
    await expect(tool.execute({ url: '' })).rejects.toThrow('url 不能为空')
  })

  it('非 http(s) 协议 → 抛错', async () => {
    await expect(tool.execute({ url: 'ftp://x.example' })).rejects.toThrow('url 必须以 http:// 或 https:// 开头')
    await expect(tool.execute({ url: 'example.com' })).rejects.toThrow('url 必须以')
  })

  it('HTTP 非 2xx → 抛错', async () => {
    mockSafeFetch.mockResolvedValueOnce({ status: 404, body: Buffer.alloc(0) } as any)
    await expect(tool.execute({ url: 'https://example.com/404' })).rejects.toThrow('HTTP 404')
  })

  it('正常抓取 → 返回 {url, title, content}', async () => {
    mockSafeFetch.mockResolvedValueOnce({ status: 200, body: Buffer.from(sampleHtml, 'utf8') } as any)
    const out = JSON.parse(await tool.execute({ url: 'https://example.com' }))
    expect(out.url).toBe('https://example.com')
    expect(out.title).toBe('测试页面')
    expect(out.content).toContain('这是正文内容')
    expect(out.content).not.toContain('导航栏')
    expect(out.content).not.toContain('var x=1')
    expect(out.content).not.toContain('页脚')
  })

  it('maxChars 截断 → 末尾加 …', async () => {
    const longBody = '<html><head><title>x</title></head><body><main>' + 'a'.repeat(100) + '</main></body></html>'
    mockSafeFetch.mockResolvedValueOnce({ status: 200, body: Buffer.from(longBody, 'utf8') } as any)
    const out = JSON.parse(await tool.execute({ url: 'https://example.com', maxChars: 10 }))
    expect(out.content.length).toBeLessThanOrEqual(11) // 10 + …
    expect(out.content).toMatch(/…$/)
  })

  it('maxChars 默认 8000（不传或非正数）', async () => {
    mockSafeFetch.mockResolvedValueOnce({ status: 200, body: Buffer.from(sampleHtml, 'utf8') } as any)
    const out = JSON.parse(await tool.execute({ url: 'https://example.com', maxChars: -5 }))
    expect(out.content).toContain('这是正文内容')
  })
})

// ── web.search ───────────────────────────────────────────

describe('web.search execute', () => {
  const tool = findTool('web.search')

  it('空 query → 抛错', async () => {
    await expect(tool.execute({ query: '' })).rejects.toThrow('query 不能为空')
    await expect(tool.execute({ query: '   ' })).rejects.toThrow('query 不能为空')
  })

  it('有结果 → {query, results}', async () => {
    mockRunWebSearch.mockResolvedValueOnce([
      { title: '结果1', url: 'https://r1.example', snippet: '摘要1' }
    ])
    const out = JSON.parse(await tool.execute({ query: 'test' }))
    expect(out.query).toBe('test')
    expect(out.results).toHaveLength(1)
    expect(out.results[0].title).toBe('结果1')
  })

  it('无结果 → {query, results:[], note}', async () => {
    mockRunWebSearch.mockResolvedValueOnce([])
    const out = JSON.parse(await tool.execute({ query: 'noresults' }))
    expect(out.results).toEqual([])
    expect(out.note).toBeTruthy()
  })

  it('count 透传给 runWebSearch', async () => {
    mockRunWebSearch.mockResolvedValueOnce([])
    await tool.execute({ query: 'x', count: 8 })
    expect(mockRunWebSearch).toHaveBeenCalledWith('x', 8, undefined)
  })
})

// ── js.eval ──────────────────────────────────────────────

describe('js.eval execute', () => {
  const tool = findTool('js.eval')

  it('空 code → 抛错', async () => {
    await expect(tool.execute({ code: '' })).rejects.toThrow('code 不能为空')
    await expect(tool.execute({ code: '   ' })).rejects.toThrow('code 不能为空')
  })

  it('有 code → 透传 runJsEval 结果', async () => {
    mockRunJsEval.mockResolvedValueOnce('eval-result')
    const out = await tool.execute({ code: 'return 1+2' })
    expect(out).toBe('eval-result')
    expect(mockRunJsEval).toHaveBeenCalledWith('return 1+2', undefined)
  })
})
