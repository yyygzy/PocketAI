// V4-Iter-397（收 §394 那笔账）：知识库健康检查那把尺子的"新半边"端到端演一遍
//
// §394 只把迁移 v52 与判据 `doc.updatedAt ?? doc.createdAt` 落了码，**新半边没有行为用例**——
// `tests/task-scheduler.test.ts` 那五例喂的文档都不带 `updatedAt`，走的正是回退那一支。
// 也就是说：把判据改回 `doc.createdAt`（＝缺陷本身），当时的 CI 是全绿的。本文件补的就是这一发。
//
// 为什么这一枚走真库而不是继续 mock：缺陷的两半分处两层——写侧 `setStatus` 到底有没有把
// `updated_at` 落进那一列、读侧那把尺子用的是不是这一列。mock 只能钉读侧（它自己造的那份行），
// 写侧一崩（少写一列、`rowToRecord` 漏带回）屏上照样是"重试一次就秒标失败"，而 mock 全绿。
// ⇒ 这里真库＋真 repo＋真 `tick()`，最后再来一发"读侧改回旧尺子"的内存版变异，证明判据有牙。
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-kb-updated-at-397'
  return { dir, data: dir + sep + 'data', db: dir + sep + 'data' + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => P.dir, getPath: () => P.dir }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { kbDocRepo } from '../src/main/db/repositories/kb-doc.repo'
import { tick } from '../src/main/backup/task-scheduler'
import type { KbDocument, KbDocStatus } from '../src/shared/types'

const HOUR = 3600 * 1000
const TWO_MONTHS = 60 * 24 * HOUR

/** 直接摆一份"卡了很久的文档"：created_at 两个月前，updated_at 由 over 决定（不给＝NULL＝迁移前的旧行） */
function seedDoc(id: string, status: KbDocStatus, over: { updatedAt?: number | null }): void {
  const db = dbService.getHandle()
  db.prepare(
    `INSERT INTO kb_documents (id, kb_id, source, source_type, title, chunk_count, status, error, content_hash, enabled, created_at, updated_at)
     VALUES (?, 'kb1', ?, 'txt', ?, 0, ?, NULL, NULL, 1, ?, ?)`
  ).run(id, `${id}.txt`, id, status, Date.now() - TWO_MONTHS, over.updatedAt ?? null)
}

function docOf(id: string): KbDocument {
  const d = kbDocRepo.get(id)
  if (!d) throw new Error(`读不回来：${id}`)
  return d
}

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  const db = dbService.getHandle()
  db.prepare(`INSERT INTO knowledge_bases (id, name, created_at) VALUES ('kb1', 'KB', ?)`).run(Date.now())
})

afterAll(() => {
  try {
    dbService.close()
  } catch { /* 关不掉不掩盖结论 */ }
  try {
    fs.rmSync(P.dir, { recursive: true, force: true })
  } catch { /* scratch 残留由 CI 的临时目录承担 */ }
})

describe('① 写侧：那一列真的被写进去、也真的被读回来', () => {
  it('v52 之后 `kb_documents` 有 `updated_at` 这一列（可空）', () => {
    const cols = dbService.getHandle().prepare('PRAGMA table_info(kb_documents)').all() as Array<{ name: string; notnull: number }>
    const col = cols.find((c) => c.name === 'updated_at')
    expect(col, `现数列：${cols.map((c) => c.name).join(', ')}`).toBeTruthy()
    expect(col!.notnull, '迁移前旧行没有这一列 ⇒ 必须可空').toBe(0)
  })

  it('新建那一条不带这一列（insert 的 SQL 里没有它 ⇒ null，不是 0 也不是创建时间）', () => {
    const d = kbDocRepo.insert({ kbId: 'kb1', source: 'new.txt', sourceType: 'txt' })
    expect(d.updatedAt ?? null, `现数新建文档的 updatedAt：${String(d.updatedAt)}`).toBeNull()
    expect(d.createdAt).toBeGreaterThan(0)
  })

  it('setStatus 写时间戳：改前那一版只写 status/error ⇒ 这一句当场红', () => {
    const d = kbDocRepo.insert({ kbId: 'kb1', source: 'set.txt', sourceType: 'txt' })
    expect(docOf(d.id).updatedAt ?? null).toBeNull()
    const before = Date.now()
    kbDocRepo.setStatus(d.id, 'indexing', undefined)
    const after = docOf(d.id)
    expect(after.status).toBe('indexing')
    expect(after.updatedAt ?? 0, `现数 updatedAt：${String(after.updatedAt)}`).toBeGreaterThanOrEqual(before)
    expect(after.createdAt).toBe(d.createdAt)
  })

  it('重试一份老文档＝status 回到 pending 且 updated_at 前进，created_at 不动', () => {
    const d = kbDocRepo.insert({ kbId: 'kb1', source: 'retry.txt', sourceType: 'txt' })
    kbDocRepo.setStatus(d.id, 'error', '上一次失败了')
    const first = docOf(d.id).updatedAt ?? 0
    expect(first).toBeGreaterThan(0)
    // 重试：同一发会先把状态打回 pending（本仓的重试入口就是 setStatus(id,'pending')）
    kbDocRepo.setStatus(d.id, 'pending', undefined)
    const again = docOf(d.id)
    expect(again.status).toBe('pending')
    expect(again.updatedAt ?? 0, 'updated_at 必须跟着这一发往前走到当前状态').toBeGreaterThanOrEqual(first)
    expect(again.createdAt, 'created_at 是"什么时候入库"，不随状态变').toBe(d.createdAt)
  })
})

describe('② 读侧端到端：真 tick() 跑真库，刚重试过的那一份不许被秒标失败', () => {
  beforeAll(() => {
    // 同一把尺子（1h）下的四种到货：只有第三种改前会被误标
    seedDoc('fresh-retry', 'parsing', { updatedAt: Date.now() - 5 * 60 * 1000 })
    seedDoc('really-stuck', 'parsing', { updatedAt: Date.now() - 2 * HOUR })
    seedDoc('legacy-row', 'indexing', { updatedAt: null })
    seedDoc('done-doc', 'ready', { updatedAt: Date.now() - 2 * HOUR })
  })

  it('tick 一次：卡住且刚重试过的留原状态，真超时的标 error（并带上原因文案）', async () => {
    await tick()
    expect(docOf('fresh-retry').status, '改前形状＝每次重试都必然在下一拍被判死').toBe('parsing')
    expect(docOf('really-stuck').status).toBe('error')
    expect(docOf('really-stuck').error, '新尺子不许把原因文案也改掉').toContain('索引超时')
    expect(docOf('legacy-row').status, '迁移前的旧行（没有这一列的值）必须回退按 created_at 判').toBe('error')
    expect(docOf('legacy-row').error).toContain('索引超时')
    expect(docOf('done-doc').status, '已完结状态即使很旧也不动').toBe('ready')
  })

  it('读侧变异（内存版）：同一批真库行喂两版尺子 ⇒ 刚重试那一份只有新尺子救得下', () => {
    // 接线（真 tick 用真 repo）已由上一条演过；这一条只证"两版尺子结果不同"＝上一条不是恒绿。
    // 自己现摆两份（不依赖上一条跑完后的状态）：跨用例的状态耦合会让判据说不清是谁那一发改的。
    seedDoc('v-fresh', 'pending', { updatedAt: Date.now() - 5 * 60 * 1000 })
    seedDoc('v-stuck', 'pending', { updatedAt: Date.now() - 2 * HOUR })
    const docs = kbDocRepo.listAll().filter((d) => ['pending', 'parsing', 'indexing'].includes(d.status))
    const now = Date.now()
    const STUCK = 1 * HOUR
    const byOld = docs.filter((d) => now - d.createdAt > STUCK).map((d) => d.id)
    const byNew = docs.filter((d) => now - (d.updatedAt ?? d.createdAt) > STUCK).map((d) => d.id)
    expect(byOld, '旧尺子把刚重试的那一份也判死了（这才叫缺陷）').toContain('v-fresh')
    expect(byNew, `现数新尺子要标的：${byNew.join(', ')}`).not.toContain('v-fresh')
    expect(byNew).toContain('v-stuck')
  })
})
