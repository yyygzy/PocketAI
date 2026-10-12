// 向量索引真实规模（数据健康卡片的数据源）
//
// 卡片以前读的是 vectors.db 的体积，而那个文件本版本从不产出（向量在主库的
// kb_vec_map + kb_vec_<dim> 里）⇒ 恒显示空。新指标要能区分三种状态：从未建索引 /
// 单维度正常 / **多维度混用**（换过 embedding 模型，语义检索必漏一部分）。
// 用真库真表跑：桩掉 DB 就测不到 GROUP_CONCAT(DISTINCT dim) 与"表不存在"这两条真实分支。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-vector-index-stats'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { getVectorIndexStats } from '../src/main/knowledge/kb-health'

function exec(sql: string): void {
  dbService.getHandle().exec(sql)
}
function run(sql: string, ...args: unknown[]): void {
  dbService.getHandle().prepare(sql).run(...args)
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

describe('getVectorIndexStats', () => {
  it('从未写过向量（kb_vec_map 不存在）→ { count: 0, dims: [] }，不抛错', () => {
    exec('DROP TABLE IF EXISTS kb_vec_map')
    expect(getVectorIndexStats()).toEqual({ count: 0, dims: [] })
  })

  it('表存在但空 → 0 条 0 维度', () => {
    exec(`CREATE TABLE kb_vec_map (
      chunk_id TEXT PRIMARY KEY,
      vec_rowid INTEGER NOT NULL,
      dim INTEGER NOT NULL
    )`)
    expect(getVectorIndexStats()).toEqual({ count: 0, dims: [] })
  })

  it('单一维度 3 条 → 计数正确、dims 只有一项', () => {
    run(`INSERT INTO kb_vec_map VALUES ('c1', 1, 1024), ('c2', 2, 1024), ('c3', 3, 1024)`)
    expect(getVectorIndexStats()).toEqual({ count: 3, dims: [1024] })
  })

  it('换过 embedding 模型（1024 与 512 混存）→ 总数含两者、dims 升序并列', () => {
    run(`INSERT INTO kb_vec_map VALUES ('c4', 4, 512), ('c5', 5, 512)`)
    const s = getVectorIndexStats()
    expect(s.count).toBe(5)
    expect(s.dims).toEqual([512, 1024])
  })

  it('脏 dim（0 与非数字）不进 dims，但仍计入条数', () => {
    // dim 列是 INTEGER NOT NULL：用 0 与 'abc'（SQLite 整型亲和下仍可存文本）造脏值
    run(`INSERT INTO kb_vec_map VALUES ('c6', 6, 0)`)
    run(`INSERT INTO kb_vec_map VALUES ('c7', 7, 'abc')`)
    const s = getVectorIndexStats()
    expect(s.count).toBe(7)
    expect(s.dims).toEqual([512, 1024])
  })
})
