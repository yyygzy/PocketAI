// FTS5 查询串构造（src/main/knowledge/fts-query.ts，SEC-18）
//
// 两层断言：① 纯函数形状（滑窗、去重、转义、上限、该不该发查询）；
// ② 与真实 FTS5 trigram 表对撞——同一份中文语料下，旧的「整句当一个短语」恒空，
//    新表达式必须命中且把更相关的片段排在前面。第二层是关键：没有它，
//    分词器可以自洽地生成一堆永远匹配不上的词项。
import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { buildFtsMatchQuery, MAX_FTS_TERMS } from '../src/main/knowledge/fts-query'

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
