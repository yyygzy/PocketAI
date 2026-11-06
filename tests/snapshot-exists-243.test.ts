// @vitest-environment node
// P0-5 第三批②：结果卡在**点击前**判断「本机还有没有这份快照」。
//
// 判据分两层：
//  · 后端 `snapshotExists()` 只回存在性、不读内容；非法 id 一律 false（挡掉路径穿越）；
//  · 入参是一批 id（一次 IPC 查一屏），不是每条消息各查一次。
//    UI 侧的"不出现可点击按钮 + 文案说清本机没有"在 fs-write-snapshot-availability-243 里钉。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-243-snapshot-exists'
  return { dir, data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.dir + '/app.db',
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { snapshotExists, defaultSnapshotRoot } from '../src/main/agent/file-snapshots'
import { snapshotIdsSchema } from '../src/shared/schemas/agent'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

beforeAll(() => {
  fs.mkdirSync(defaultSnapshotRoot(), { recursive: true })
  fs.writeFileSync(path.join(defaultSnapshotRoot(), `${A}.json`), '{}', 'utf-8')
})

afterAll(() => fs.rmSync(P.dir, { recursive: true, force: true }))

describe('① 存在性判定', () => {
  it('本机有 ⇒ true；本机没有/非法 id ⇒ false（不抛、不读内容）', () => {
    expect(snapshotExists(A)).toBe(true)
    expect(snapshotExists(B)).toBe(false)
    // 路径穿越形状不可能命中，且不允许把异常漏给调用方
    expect(snapshotExists(`../../${A}`)).toBe(false)
    expect(snapshotExists('')).toBe(false)
  })

  it('半写的 .part 不算一份快照（异机恢复后不该出现"有快照"的误判）', () => {
    fs.writeFileSync(path.join(defaultSnapshotRoot(), `${B}.json.abc.part`), '{"id":"x"}', 'utf-8')
    expect(snapshotExists(B)).toBe(false)
  })
})

describe('② 入参是一批（避免每条消息一次 IPC）', () => {
  it('批量形状通过；超过 500 个直接拒（一屏不会要这么多）', () => {
    expect(snapshotIdsSchema.safeParse([A, B]).success).toBe(true)
    expect(snapshotIdsSchema.safeParse(Array.from({ length: 501 }, () => A)).success).toBe(false)
    expect(snapshotIdsSchema.safeParse('not-an-array').success).toBe(false)
  })
})
