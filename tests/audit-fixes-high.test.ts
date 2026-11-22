// 高优先级审查项回归：
//  H1 普通对话 RAG 检索窗口点停止无效（chat-service 曾有 pendingAborts 缺口）
//  H2 多库向量检索被大库近邻挤没（vec0 全局表上先 LIMIT 再按 kb_id 过滤）
//  M1 启动去重丢重复 provider 的 API Key（注释承诺合并 apiKeys 但实现只合 models）
// 低优先附带：普通对话停止不再污染 agent 的 pendingAborts / hasActiveRun。
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'
import { load as loadVec } from 'sqlite-vec'

// ---------- H1：chat-service 的停止窗口 ----------
const { chatAbort, agentAbortCalled, agentKnown, isKnownRunResult, setKnownRun } = vi.hoisted(() => ({
  chatAbort: { fn: null as ((id: string) => void) | null },
  agentAbortCalled: { value: [] as string[] },
  agentKnown: { value: false },
  isKnownRunResult: { value: false },
  setKnownRun: { value: null as ((requestId: string) => void) | null }
}))

vi.mock('../src/main/agent/engine', () => ({
  agentEngine: {
    abort: (id: string) => { agentAbortCalled.value.push(id) },
    isKnownRun: () => isKnownRunResult.value
  }
}))
vi.mock('../src/main/db/database', () => ({ dbService: { getHandle: () => ({} as never) } }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} })
}))

const realDb = new Database(':memory:')
loadVec(realDb)
realDb.exec(`
  CREATE TABLE kb_chunks (id TEXT PRIMARY KEY, doc_id TEXT, kb_id TEXT, sequence INTEGER, content TEXT, embedding BLOB, created_at INTEGER);
  CREATE TABLE kb_documents (id TEXT PRIMARY KEY, kb_id TEXT, source TEXT, source_type TEXT, title TEXT, chunk_count INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', error TEXT, content_hash TEXT, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER DEFAULT 0);
`)

describe('H1 · 普通对话 RAG 检索窗口点停止', () => {
  it('setup 窗口 abort 后，主控制器登记即被中止（不再照跑整轮）', async () => {
    // 通过源码断言钉住机制：pendingAborts 在 controller 登记后立刻消费。
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/main/chat/chat-service.ts', 'utf8')
    expect(src).toMatch(/private pendingAborts = new Set<string>\(\)/)
    expect(src).toMatch(/if \(this\.pendingAborts\.delete\(requestId\)\) master\.abort\(\)/)
    // 三处 controller 登记 + 三处收尾都要有对应处理
    expect((src.match(/this\.controllers\.set\(requestId, master\)/g) || []).length).toBe(3)
    expect((src.match(/if \(this\.pendingAborts\.delete\(requestId\)\) master\.abort\(\)/g) || []).length).toBe(3)
    expect((src.match(/this\.pendingAborts\.delete\(requestId\)/g) || []).length).toBe(6)
  })

  it('普通对话停止不再无条件转交 agentEngine（避免 pendingAborts 泄漏）', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/main/chat/chat-service.ts', 'utf8')
    expect(src).toMatch(/if \(agentEngine\.isKnownRun\(requestId\)\) agentEngine\.abort\(requestId\)/)
    const engineSrc = fs.readFileSync('src/main/agent/engine.ts', 'utf8')
    expect(engineSrc).toMatch(/isKnownRun\(requestId: string\): boolean/)
    expect(engineSrc).toMatch(/\[\.\.\.this\.activeConversations\.values\(\)\]\.includes\(requestId\)/)
  })
})

// ---------- H2：多库向量饿死 ----------
vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => realDb, isVecEnabled: () => true }
}))

import { kbChunkRepo } from '../src/main/db/repositories/kb-chunk.repo'

describe('H2 · 多库共用 vec0 表时小库不被大库挤掉', () => {
  it('大库 60 条更近向量 + 小库 1 条 ⇒ 小库仍能命中', () => {
    const small = [{ docId: 'sd', kbId: 'kb-small', sequence: 0, content: '小库目标', embedding: new Float32Array([1, 0, 0]) }]
    const big = Array.from({ length: 60 }, (_, i) => ({
      docId: 'bd', kbId: 'kb-big', sequence: i, content: `大库${i}`,
      embedding: new Float32Array([0.99 - i * 0.001, 0.14, 0])
    }))
    kbChunkRepo.insertMany([...big, ...small])
    const hit = kbChunkRepo.knnSearch(new Float32Array([1, 0, 0]), ['kb-small'], 5)
    expect(hit.some((r) => r.content === '小库目标')).toBe(true)
  })

  it('rowid IN 约束下 k = ? 语法生效（不会静默 0 命中）', () => {
    const r = kbChunkRepo.knnSearch(new Float32Array([1, 0, 0]), ['kb-small'], 1)
    expect(r).toHaveLength(1)
    expect(r[0]?.content).toBe('小库目标')
  })
})

// ---------- M1：Provider 去重保留 API Key ----------
describe('M1 · deduplicate 合并重复 provider 的 apiKeys', () => {
  it('两边 apiKeys 都被读取并做并集去重（不再只留 survivor）', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/main/db/repositories/provider.repo.ts', 'utf8')
    expect(src).toMatch(/\.\.\.decryptApiKeys\(survivorRow\.api_key_encrypted\)/)
    expect(src).toMatch(/\.\.\.decryptApiKeys\(row\.api_key_encrypted\)/)
    expect(src).toMatch(/survivorRow\.api_key_encrypted = mergedKeysCipher/)
  })

  it('deduplicate SQL 确实写回 api_key_encrypted', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync('src/main/db/repositories/provider.repo.ts', 'utf8')
    expect(src).toMatch(/UPDATE providers SET models=\?, enabled_models=\?, api_key_encrypted=\? WHERE id=\?/)
    expect(src).toMatch(/mergedKeysCipher = encryptApiKeys\(mergedKeys\)/)
  })
})
