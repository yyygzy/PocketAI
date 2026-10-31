// V4-Iter-379（候选 #4）：`buildMemoryContext` 的预算语义。
//
// 病（两条，同一段代码）：
//  ①总预算那一圈以前是 `if (total + line.length > MAX_TOTAL_CHARS) break`——**一条放不下的长记忆
//    会把后面本来塞得下的短记忆整批挤掉**（现量：10 条 200 字 + 8 条 20 字 ⇒ break 只注入 9 条，
//    逐条试放能注入 17 条）。列表按 updated_at DESC，被挤掉的正是"较旧但仍相关"那批。
//  ②三档上限（50 条／单条 200 字／总 2000 字）在设置页完全没披露：面板把每条记忆完整显示，
//    那句提示只说「记忆将注入对话上下文」⇒ 屏上 60 条全在、模型实际只收到一部分，
//    一条 1500 字的记忆模型只看到前 200 字（＝§376「截断页当全量合计」的堂亲）。
// 修法＝`break`→`continue` ＋ 三档数字搬进 `src/shared/schemas/memory.ts`（与 MEMORY_MAX_CONTENT_CHARS 同一份）
// ＋ 四语 `set.memoryHint` 带三颗占位符、数字由调用点 params 带出（文案里不写死数字＝§361 那族）。
//
// 这里跑的是**真函数**（只桩 repo 那一发读），不 mock buildMemoryContext 自己。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = { id: string; content: string; createdAt: number; updatedAt: number }
const listMock = vi.fn(() => [] as Row[])

vi.mock('../src/main/db/repositories/user-memory.repo', () => ({
  userMemoryRepo: { list: (...args: unknown[]) => listMock(...(args as [])) }
}))

import { buildMemoryContext } from '../src/main/assistant/memory'
import {
  MEMORY_INJECT_MAX_ITEMS,
  MEMORY_INJECT_MAX_ITEM_CHARS,
  MEMORY_INJECT_MAX_TOTAL_CHARS
} from '../src/shared/schemas/memory'

const row = (i: number, content: string): Row => ({ id: `m${i}`, content, createdAt: i, updatedAt: i })
const rows = (...sizes: number[]): Row[] => sizes.map((n, i) => row(i + 1, 'x'.repeat(n)))
/** 注入正文里那几行 `- …`（头顶两行是标题与说明） */
const linesOf = (ctx: string): string[] => (ctx === '' ? [] : ctx.split('\n').slice(2))

describe('读法与常量同源（数字只有一份）', () => {
  it('三档上限取自 shared：50 条／单条 200 字／总 2000 字', () => {
    expect([MEMORY_INJECT_MAX_ITEMS, MEMORY_INJECT_MAX_ITEM_CHARS, MEMORY_INJECT_MAX_TOTAL_CHARS]).toEqual([50, 200, 2000])
  })
})

describe('① 总预算那一圈：一条放不下不等于后面全都放下', () => {
  it('10 条 200 字 + 8 条 20 字 ⇒ 注入 17 条（改前那个 break 只给 9 条＝短记忆被长记忆整批挤掉）', () => {
    listMock.mockImplementation(() => rows(...Array.from({ length: 10 }, () => 200), ...Array.from({ length: 8 }, () => 20)))
    const lines = linesOf(buildMemoryContext())
    expect(lines.length, '注入条数').toBe(17)
    // 被跳过的恰好是"第 10 条那条长的"，而不是"从第 10 条起的整批"＝不是前缀语义
    expect(lines.filter((l) => l.length === MEMORY_INJECT_MAX_ITEM_CHARS + 2).length, '长条目行数').toBe(9)
    expect(lines.filter((l) => l.length === 22).length, '短条目行数（改前是 0）').toBe(8)
  })

  it('预算不许被顶破：注入正文的总字符数 ≤ 上限（上一颗的 1994 就是贴边那一形）', () => {
    listMock.mockImplementation(() => rows(...Array.from({ length: 10 }, () => 200), ...Array.from({ length: 8 }, () => 20)))
    const used = linesOf(buildMemoryContext()).reduce((n, l) => n + l.length, 0)
    expect(used, `注入 ${used} 字 > 上限`).toBeLessThanOrEqual(MEMORY_INJECT_MAX_TOTAL_CHARS)
    expect(used, '贴边都没贴到＝这条判据是空的').toBeGreaterThan(MEMORY_INJECT_MAX_TOTAL_CHARS - MEMORY_INJECT_MAX_ITEM_CHARS)
  })

  it('正向对照：全都塞得下时一条不少（continue 不是"少注入"的另一种写法）', () => {
    listMock.mockImplementation(() => rows(...Array.from({ length: 50 }, () => 20)))
    expect(linesOf(buildMemoryContext()).length).toBe(50)
  })
})

describe('② 另外两档上限（条数与单条长度）照旧说话', () => {
  it('60 条记忆 ⇒ 只有最近 50 条参与，第 51 条与第 60 条的内容一个字都不许出现在注入里', () => {
    // 编号带首尾「编号N号」，否则 `编号6` 补零后正好含住 `编号60`＝自己造一把假阳
    const many = Array.from({ length: 60 }, (_, i) => row(i + 1, `编号${i + 1}号`.padEnd(20, '0')))
    listMock.mockImplementation(() => many)
    const ctx = buildMemoryContext()
    expect(linesOf(ctx).length).toBe(MEMORY_INJECT_MAX_ITEMS)
    expect(ctx, '第 51 条被注入＝条数上限没牙').not.toContain('编号51号')
    expect(ctx, '第 60 条被注入').not.toContain('编号60号')
    expect(ctx, '正向对照：第 50 条该在').toContain('编号50号')
  })

  it('一条 1500 字的记忆 ⇒ 注入里那条只有单条上限那么长（屏上仍是完整一条＝所以设置页那句必须说出来）', () => {
    listMock.mockImplementation(() => rows(1500))
    const lines = linesOf(buildMemoryContext())
    expect(lines.length).toBe(1)
    expect(lines[0]!.length).toBe(MEMORY_INJECT_MAX_ITEM_CHARS + 2)
  })

  it('空白折叠与空条目：多条空白不进注入，全空白 ⇒ 空串（宁可不注入也不给模型一行 `- `）', () => {
    listMock.mockImplementation(() => [row(1, '  喜欢   简洁\n回复  '), row(2, '   '), row(3, '')])
    const lines = linesOf(buildMemoryContext())
    expect(lines).toEqual(['- 喜欢 简洁 回复'])
    listMock.mockImplementation(() => [row(1, '   ')])
    expect(buildMemoryContext()).toBe('')
    listMock.mockImplementation(() => [])
    expect(buildMemoryContext()).toBe('')
  })

  it('注入顺序＝repo 给的回顺序（continue 只跳过，不重排）', () => {
    listMock.mockImplementation(() => [row(1, '最新'), row(2, '中间'), row(3, '最旧')])
    expect(linesOf(buildMemoryContext())).toEqual(['- 最新', '- 中间', '- 最旧'])
  })
})

describe('③ 闸门跑不动的那半：预算语义变了就得当场红', () => {
  it('把一条长记忆放在最前面也不会把整批挤没（首条永不丢＝至少注入一条）', () => {
    listMock.mockImplementation(() => rows(200, ...Array.from({ length: 40 }, () => 20)))
    expect(linesOf(buildMemoryContext()).length, '一条长记忆让整发注入变空＝比少注入更糟').toBeGreaterThan(0)
  })

  it('每条都恰好放不下（长度＝上限＋1 的畸形输入）⇒ 不注入而不是抛错或注入半条', () => {
    // 单条已被截到 200 字，这一形是"上限被改坏"时才会出现的畸形；判它安静地什么都不注入
    const huge = 'y'.repeat(MEMORY_INJECT_MAX_TOTAL_CHARS + 10)
    listMock.mockImplementation(() => [row(1, huge)])
    const ctx = buildMemoryContext()
    expect(ctx.length, '单条截断没生效＝整段塞进 prompt').toBeLessThan(MEMORY_INJECT_MAX_TOTAL_CHARS)
  })
})

beforeEach(() => {
  listMock.mockClear()
  listMock.mockImplementation(() => [])
})
