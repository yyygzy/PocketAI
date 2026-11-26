// FTS5 查询串构造（src/main/knowledge/fts-query.ts，SEC-18）
//
// 两层断言：① 纯函数形状（滑窗、去重、转义、上限、该不该发查询）；
// ② 与真实 FTS5 trigram 表对撞——同一份中文语料下，旧的「整句当一个短语」恒空，
//    新表达式必须命中且把更相关的片段排在前面。第二层是关键：没有它，
//    分词器可以自洽地生成一堆永远匹配不上的词项。
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import {
  buildFtsMatchQuery,
  buildShortFtsMatchQuery,
  cjkSpacedText,
  MAX_FTS_TERMS
} from '../src/main/knowledge/fts-query'

describe('buildFtsMatchQuery — 词项形状', () => {
  it('CJK 段切成 3 字滑窗并以 OR 连接、加引号', () => {
    // 4 字段的滑窗是 2 个（i 只能取 0/1），末窗仍覆盖到最后一个字
    expect(buildFtsMatchQuery('知识库检')).toBe('"知识库" OR "识库检"')
    expect(buildFtsMatchQuery('知识库检索')).toBe('"知识库" OR "识库检" OR "库检索"')
  })

  it('重复窗口去重（叠字场景）', () => {
    const q = buildFtsMatchQuery('人人人')!
    expect(q.split(' OR ')).toHaveLength(1)
    expect(q).toBe('"人人人"')
  })

  it('1-2 字 CJK 查询不产出词项（trigram 恒空，交给向量路）', () => {
    expect(buildFtsMatchQuery('内存')).toBeNull()
    expect(buildFtsMatchQuery('库')).toBeNull()
    expect(buildFtsMatchQuery('')).toBeNull()
    expect(buildFtsMatchQuery('   ')).toBeNull()
  })

  it('拉丁/数字词整词保留，标点当分隔符', () => {
    expect(buildFtsMatchQuery('how does BM25 work?')).toBe('"how" OR "does" OR "BM25" OR "work"')
    expect(buildFtsMatchQuery('gpt-4 mini')).toBe('"gpt-4" OR "mini"')
  })

  it('中英混排同时产出两类词项', () => {
    const q = buildFtsMatchQuery('向量检索 embedding')!
    expect(q).toContain('"向量检"')
    expect(q).toContain('"量检索"')
    expect(q).toContain('"embedding"')
  })

  it('内嵌双引号被加倍转义，不改变 MATCH 语法', () => {
    const q = buildFtsMatchQuery('he said "hi" loudly again')!
    expect(q).toContain('"hi"')
    expect(() => new Database(':memory:').prepare('SELECT 1').get()).not.toThrow()
    // 转义后仍是一个合法表达式：每个词项都被外层引号包住
    for (const term of q.split(' OR ')) {
      expect(term.startsWith('"') && term.endsWith('"')).toBe(true)
    }
  })

  it('词项总数受 MAX_FTS_TERMS 约束（长句不产出上百个 gram）', () => {
    const long = '知'.repeat(200)
    const q = buildFtsMatchQuery(long)!
    expect(q.split(' OR ').length).toBeLessThanOrEqual(MAX_FTS_TERMS)
  })
})

describe('buildFtsMatchQuery × 真实 FTS5 trigram 表', () => {
  function makeDb() {
    const db = new Database(':memory:')
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(content, tokenize='trigram')`)
    const ins = db.prepare('INSERT INTO t(content) VALUES (?)')
    ins.run('知识库检索系统使用向量与 BM25 双路混合召回')
    ins.run('今天天气不错，适合出门散步')
    ins.run('MCP server 的工具列表需要握手后才能拿到')
    return db
  }
  const hits = (db: Database.Database, match: string | null) =>
    match === null
      ? []
      : (db
          .prepare('SELECT bm25(t) AS b, substr(content,1,6) AS c FROM t WHERE t MATCH ? ORDER BY b ASC')
          .all(match) as Array<{ c: string }>).map((r) => r.c)

  it('旧写法（整句一个短语）对自然语言问句恒空，新写法命中相关片段', () => {
    const db = makeDb()
    const query = '知识库检索是怎么做的'
    const legacy = `"${query.replace(/"/g, '""')}"`
    expect(hits(db, legacy)).toEqual([])
    const built = buildFtsMatchQuery(query)
    expect(built).not.toBeNull()
    expect(hits(db, built)[0]).toBe('知识库检索系')
  })

  it('命中数更多的片段排名更前（多窗口 OR 的实际收益）', () => {
    const db = makeDb()
    const built = buildFtsMatchQuery('向量与混合召回的实现')!
    const rows = hits(db, built)
    expect(rows[0]).toBe('知识库检索系')
    expect(rows).not.toContain('MCP serv'.slice(0, 6))
  })

  it('空表达式在 SQLite 侧真的会抛错（所以必须返回 null 让调用方跳过 BM25 路）', () => {
    const db = makeDb()
    expect(buildFtsMatchQuery('好的')).toBeNull()
    expect(() => db.prepare('SELECT 1 FROM t WHERE t MATCH ?').get('')).toThrow(/fts5/)
  })
})

// ── 阶段 2：1–2 字短中文辅助路（unicode61 + 单字展开） ──────────────────────
describe('短查询辅助路 — 纯函数', () => {
  it('cjkSpacedText 把 CJK 逐字展开，非 CJK 原样保留', () => {
    expect(cjkSpacedText('人工智能')).toBe('人 工 智 能')
    expect(cjkSpacedText('AI 人工智能')).toBe('AI 人 工 智 能')
    expect(cjkSpacedText('')).toBe('')
  })

  it('1–2 字 CJK 产出相邻短语（trigram 主路这些查询返回 null）', () => {
    expect(buildFtsMatchQuery('库')).toBeNull()
    expect(buildShortFtsMatchQuery('库')).toBe('"库"')
    expect(buildFtsMatchQuery('内存')).toBeNull()
    expect(buildShortFtsMatchQuery('内存')).toBe('"内 存"')
  })

  it('≥3 字 CJK 不产出词项，长查询完全交给 trigram 主路', () => {
    expect(buildShortFtsMatchQuery('知识库')).toBeNull()
    expect(buildShortFtsMatchQuery('知识库检索')).toBeNull()
  })

  it('短拉丁/数字词也补齐（trigram 对 ≤2 字符同样匹配不到）', () => {
    expect(buildShortFtsMatchQuery('AI')).toBe('"AI"')
    expect(buildShortFtsMatchQuery('BM25')).toBeNull()
  })

  it('重复短段去重、空查询返回 null', () => {
    expect(buildShortFtsMatchQuery('库 库')).toBe('"库"')
    expect(buildShortFtsMatchQuery('')).toBeNull()
    expect(buildShortFtsMatchQuery('   ')).toBeNull()
  })

  it('内嵌双引号被转义，不破坏 MATCH 表达式', () => {
    const q = buildShortFtsMatchQuery('"库"')!
    expect(q).toBe('"库"')
    for (const term of q.split(' OR ')) {
      expect(term.startsWith('"') && term.endsWith('"')).toBe(true)
    }
  })
})

describe('短查询辅助路 × 真实 FTS5 unicode61 表', () => {
  function makeDb() {
    const db = new Database(':memory:')
    db.exec(`CREATE VIRTUAL TABLE t USING fts5(content, tokenize='unicode61')`)
    const ins = db.prepare('INSERT INTO t(content) VALUES (?)')
    for (const text of [
      '知识库检索系统使用向量与 BM25 双路混合召回',
      '今天天气不错，适合出门散步',
      'MCP server 的工具列表需要握手后才能拿到',
      'AI 助手可以回答问题'
    ]) {
      ins.run(cjkSpacedText(text))
    }
    return db
  }
  const hits = (db: Database.Database, match: string | null): string[] =>
    match === null
      ? []
      : (db
          .prepare('SELECT content AS c FROM t WHERE t MATCH ? ORDER BY bm25(t) ASC')
          .all(match) as Array<{ c: string }>).map((r) => r.c)

  it('1 字中文命中包含该字的片段（trigram 表此处恒空）', () => {
    const db = makeDb()
    const lib = hits(db, buildShortFtsMatchQuery('库'))
    expect(lib).toHaveLength(1)
    expect(lib[0]).toContain('知 识 库')
    expect(hits(db, buildShortFtsMatchQuery('天'))).toHaveLength(1)
  })

  it('2 字中文按相邻短语命中，不跨文档/不跨字符', () => {
    const db = makeDb()
    expect(hits(db, buildShortFtsMatchQuery('知识'))[0]).toContain('知 识 库')
    expect(hits(db, buildShortFtsMatchQuery('天气'))[0]).toContain('今 天 天 气')
    // 「库天」分属两句，展开后不相邻 ⇒ 不应命中
    expect(hits(db, buildShortFtsMatchQuery('库天'))).toEqual([])
  })

  it('辅助路不抢长查询：≥3 字段不产出 MATCH 词项', () => {
    const db = makeDb()
    expect(hits(db, buildShortFtsMatchQuery('知识库'))).toEqual([])
    expect(hits(db, buildShortFtsMatchQuery('知识库检索'))).toEqual([])
  })

  it('2 字拉丁词命中，长拉丁词不短路', () => {
    const db = makeDb()
    expect(hits(db, buildShortFtsMatchQuery('AI'))[0]).toContain('AI 助 手')
    expect(hits(db, buildShortFtsMatchQuery('BM25'))).toEqual([])
  })
})
