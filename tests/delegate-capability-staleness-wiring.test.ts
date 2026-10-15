// 失效判定的接线（V4-Iter-142）——判定本身是纯函数（judge 用例覆盖），这一份只证"主进程真的取了数"
//
// 为什么要单独一份：`isDelegateEntryStale` 写对了不等于有人调它。
// 140 那条教训就是"采到数据 ≠ 接上了"——所以这里整块打桩 ollama-runtime（唯一可控的外部真值），
// 断的是 `listDelegateCapabilitiesWithStaleness` 有没有把**当前** tags 清单与 provider 类型喂进判定。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-staleness'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

const H = vi.hoisted(() => ({ tags: [] as Array<{ name: string; digest: string }> }))

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.dir,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.ext,
  isPortable: () => false,
  portableDataDir: () => P.dir
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../src/main/ollama/ollama-runtime', () => ({
  ollamaRuntime: {
    listModelDetails: async () => H.tags,
    listLoadedModels: async () => [],
    listModels: async () => H.tags.map((t) => t.name)
  }
}))

import { dbService } from '../src/main/db/database'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { listDelegateCapabilitiesWithStaleness } from '../src/main/agent/delegate-capability'

const K = 'agent.delegate_capability'

function putEntry(providerId: string, model: string, digest: string): void {
  appConfigRepo.set(
    K,
    JSON.stringify([{ providerId, model, capability: 'native_tools_ok', samples: 3, nativeHits: 3, digest, checkedAt: 1 }])
  )
}

let LOCAL = ''
let CLOUD = ''

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  LOCAL = providerRepo.save({
    id: '',
    type: 'ollama',
    name: '本机 Ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeys: [],
    models: ['qwen2.5:3b-instruct'],
    enabled: true,
    createdAt: Date.now()
  }).id
  CLOUD = providerRepo.save({
    id: '',
    type: 'openai-compatible',
    name: '云端',
    baseUrl: 'https://example.invalid/v1',
    apiKeys: [],
    models: ['gpt-x'],
    enabled: true,
    createdAt: Date.now()
  }).id
})

afterAll(() => {
  try {
    dbService.close()
  } catch {
    /* 已关则忽略 */
  }
  fs.rmSync(P.dir, { recursive: true, force: true })
})

beforeEach(() => {
  H.tags = []
})

describe('stale 判定接的是真 tags 清单', () => {
  it('正向：本地模型镜像摘要换了 ⇒ stale=true（这是这一态唯一会被判真的那一侧）', async () => {
    putEntry(LOCAL, 'qwen2.5:3b-instruct', 'sha256:old')
    H.tags = [{ name: 'qwen2.5:3b-instruct', digest: 'sha256:new' }]
    const list = await listDelegateCapabilitiesWithStaleness()
    expect(list[0]!.stale).toBe(true)
  })

  it('摘要没变 ⇒ 新鲜', async () => {
    putEntry(LOCAL, 'qwen2.5:3b-instruct', 'sha256:same')
    H.tags = [{ name: 'qwen2.5:3b-instruct', digest: 'sha256:same' }]
    expect((await listDelegateCapabilitiesWithStaleness())[0]!.stale).toBe(false)
  })

  it('serve 没起（一条 tags 都取不到）⇒ 不许说"已过期"，那是"无法核对"', async () => {
    putEntry(LOCAL, 'qwen2.5:3b-instruct', 'sha256:old')
    H.tags = []
    const list = await listDelegateCapabilitiesWithStaleness()
    expect(list[0]!.capability).toBe('native_tools_ok')
    expect(list[0]!.stale).toBe(false)
  })

  it('云端 provider 没有失效键 ⇒ 永远不下过期结论', async () => {
    putEntry(CLOUD, 'gpt-x', 'sha256:whatever')
    H.tags = [{ name: 'gpt-x', digest: 'sha256:other' }]
    expect((await listDelegateCapabilitiesWithStaleness())[0]!.stale).toBe(false)
  })

  it('同名命中优先于同族命中（本机同时有 3b 与 7b 时不许拿错摘要）', async () => {
    putEntry(LOCAL, 'qwen2.5:3b', 'sha256:3b')
    H.tags = [
      { name: 'qwen2.5:7b', digest: 'sha256:7b' },
      { name: 'qwen2.5:3b', digest: 'sha256:3b' }
    ]
    expect((await listDelegateCapabilitiesWithStaleness())[0]!.stale).toBe(false)
  })

  it('只有同族标签时按族匹配（存 `qwen2.5:3b`、tags 里是 `qwen2.5:3b-instruct`）', async () => {
    putEntry(LOCAL, 'qwen2.5:3b', 'sha256:a')
    H.tags = [{ name: 'qwen2.5:3b-instruct', digest: 'sha256:b' }]
    expect((await listDelegateCapabilitiesWithStaleness())[0]!.stale).toBe(true)
  })
})
