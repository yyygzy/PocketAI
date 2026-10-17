// 判据汇总的真库用例（V4-Iter-146 / B81）
//
// 这块屏最容易被写歪的地方不在渲染，而在**取数**：
//  · 总量必须与 141 闸门读的是同一个数（否则界面说"4096"而闸门按另一次采集判定 ⇒ 又是一处"两个口径"）；
//  · 现采的"已用"只能被观察，**不许进判据**（用户 2026-10-16 选定，理由见 local-capacity 文件头：
//    同驻与驱逐之间只差 128MiB，任何拿剩余显存做算术的写法都会给出错答案）；
//  · 「走不走检索链」是助手级事实，必须逐助手算，不能给一个机器级的真/假。
// 现采那一路用注入替掉——它读的是真 nvidia-smi，用例里不该依赖机器上有没有独显。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-judgement'
  return { dir, db: dir + sep + 'app.db', ext: dir + sep + 'ext' }
})

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

import { dbService } from '../src/main/db/database'
import { assistantRepo } from '../src/main/db/repositories/assistant.repo'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { providerRepo } from '../src/main/db/repositories/provider.repo'
import { kbRepo } from '../src/main/db/repositories/kb.repo'
import { BUILTIN_EMBED_PROVIDER_ID } from '../src/shared/types'
import { computeLocalJudgements } from '../src/main/steward/local-judgement'
import { configureLocalSlot, resetLocalSlotsForTest } from '../src/main/providers/local-slot'

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.dir, { recursive: true })
  dbService.open()
  dbService.runMigrations()
  // '*' 全授权 ⇒ 工具面里有 kb_search ⇒ 这条编排算"走检索链"
  assistantRepo.save({
    name: '全授权助手',
    systemPrompt: 'x',
    toolPermissions: ['*'],
    knowledgeBaseIds: [],
    skillIds: []
  }).id
  // 显式只给两把内置工具 ⇒ 不碰检索
  assistantRepo.save({
    name: '不碰知识库的助手',
    systemPrompt: 'x',
    toolPermissions: ['time.now', 'agent.delegate'],
    knowledgeBaseIds: [],
    skillIds: []
  }).id
  /**
   * 150：第二条合取现在判的是"检索链的 embedding 落不落在本机端点"，
   * 这句话只能拿真库 + 真 provider 行来证（打桩就变成"我在测自己的桩"）。
   */
  const localEmbed = providerRepo.save({
    id: '',
    type: 'ollama',
    name: '本地 embedding 端点',
    baseUrl: 'http://127.0.0.1:11434/v1',
    apiKeys: [],
    models: ['bge-m3'],
    enabled: true,
    createdAt: Date.now()
  }).id
  const kbLocal = kbRepo.save({ name: '带本地 embedding 的库', embeddingProviderId: localEmbed, embeddingModel: 'bge-m3' }).id
  const kbCpu = kbRepo.save({
    name: '内置 CPU embedding 的库',
    embeddingProviderId: BUILTIN_EMBED_PROVIDER_ID,
    embeddingModel: 'bge-small-zh-v1.5'
  }).id
  assistantRepo.save({
    name: '绑本地 embedding 库的助手',
    systemPrompt: 'x',
    toolPermissions: ['time.now'],
    knowledgeBaseIds: [kbLocal],
    skillIds: []
  }).id
  assistantRepo.save({
    name: '绑内置 CPU 库的助手',
    systemPrompt: 'x',
    toolPermissions: ['time.now'],
    knowledgeBaseIds: [kbCpu],
    skillIds: []
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
  resetLocalSlotsForTest()
  appConfigRepo.set('agent.delegate_capability', '')
})

const liveOk = async () => [{ name: 'GTX 1050 Ti', totalMiB: 4096, usedMiB: 3149 }]

describe('总量与闸门同源、现采不进判据', () => {
  it('判据屏说的总显存就是闸门据以判定的那个数（4GiB 实测档 ⇒ measured）', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    const r = await computeLocalJudgements({ readLiveVram: liveOk, now: () => 111 })
    expect(r.totalVramMiB).toBe(4096)
    expect(r.capacity.measured).toBe(true)
    expect(r.collectedAt).toBe(111)
  })

  it('采不到总量 ⇒ totalVramMiB 为 null，判据退回保守默认（vram-unknown）', async () => {
    configureLocalSlot({ readVramMiB: () => null })
    const r = await computeLocalJudgements({ readLiveVram: liveOk })
    expect(r.totalVramMiB).toBeNull()
    expect(r.capacity.measured).toBe(false)
    expect(r.capacity.reasons).toContain('vram-unknown')
  })

  it('现采"已用"从 3149 改成 100，判据一个字都不变——它只被观察，不是输入', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    const a = await computeLocalJudgements({ readLiveVram: liveOk })
    const b = await computeLocalJudgements({
      readLiveVram: async () => [{ name: 'GTX 1050 Ti', totalMiB: 4096, usedMiB: 100 }]
    })
    expect(b.capacity).toEqual(a.capacity)
    expect(b.totalVramMiB).toBe(a.totalVramMiB)
    // 但读数本身是要显示给用户的，所以两处确实不同 ⇒ 上面那条相等不是空断言
    expect(b.liveVram.rows[0]!.usedMiB).toBe(100)
    expect(a.liveVram.rows[0]!.usedMiB).toBe(3149)
  })

  it('现采抛错 ⇒ 报告仍然成立，只是那行标"采不到"（一次硬件读取失败不该拖垮整屏）', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    const r = await computeLocalJudgements({
      readLiveVram: async () => {
        throw new Error('nvidia-smi 不在场')
      }
    })
    expect(r.liveVram).toEqual({ available: false, rows: [] })
    expect(r.capacity.measured).toBe(true)
  })

  it('现采返回空数组（AMD / Mac / 无独显）⇒ available=false，**不许**填估算值', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    const r = await computeLocalJudgements({ readLiveVram: async () => [] })
    expect(r.liveVram.available).toBe(false)
  })
})

describe('第二条合取按助手算（150 起还要看 embedding 落在哪）', () => {
  it('四种助手各算自己的：走不走检索链、embedding 落不落本机、由此得出的三态取值', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    const r = await computeLocalJudgements({ readLiveVram: liveOk })
    const byName = new Map(r.roleVerdicts.map((v) => [v.assistantName, v]))
    expect(r.roleVerdicts).toHaveLength(4)

    const full = byName.get('全授权助手')!
    expect(full.childUsesRetrieval, "'*' 面里有 kb_search ⇒ 算走检索链").toBe(true)
    expect(full.retrievalHitsLocalEndpoint, '没绑库 ⇒ kb_search 检索不到任何东西，也就不可能加载 embedding').toBe(false)

    const none = byName.get('不碰知识库的助手')!
    expect(none.childUsesRetrieval).toBe(false)
    expect(none.retrievalHitsLocalEndpoint).toBe(false)

    const local = byName.get('绑本地 embedding 库的助手')!
    expect(local.childUsesRetrieval).toBe(true)
    expect(local.retrievalHitsLocalEndpoint, '库的 embedding 指向本机 Ollama ⇒ 这条才真的吃显存').toBe(true)
    // 两条合取各拦各的：①（4GiB 默认档没过）与②都在 ⇒ 任何落点都不放
    expect(local.reasons).toContain('retrieval-chain-exclusive')
    expect(local.scope).toBe('not-allowed')

    const cpu = byName.get('绑内置 CPU 库的助手')!
    expect(cpu.childUsesRetrieval, '绑了库，检索链照走').toBe(true)
    expect(cpu.retrievalHitsLocalEndpoint, '内置那路是 onnxruntime CPU 推理 ⇒ 不占这张卡').toBe(false)
    expect(cpu.reasons, '不该再拿 M10 当它的理由').not.toContain('retrieval-chain-exclusive')
    // 今天 ① 恒不过 ⇒ ①只关本地落点：云子不占本机显存，所以取值是 cloud-only（界面 164 起写「只能跑在云端」）而不是"关死"
    expect(cpu.reasons).toContain('distinct-roles-not-measured')
    expect(cpu.scope).toBe('cloud-only')
    expect(none.scope).toBe('cloud-only')
    expect(full.scope).toBe('cloud-only')
  })
})

describe('委派判定与槽位现状原样搬出来', () => {
  it('142 存了三台判定 ⇒ 报告里三台，字段一个不丢（判定不在这里重算）', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    appConfigRepo.set(
      'agent.delegate_capability',
      JSON.stringify([
        { key: 'p1::m1', providerId: 'p1', model: 'm1', capability: 'native_tools_ok', samples: 3, nativeHits: 3, digest: '', checkedAt: 9 },
        { key: 'p1::m2', providerId: 'p1', model: 'm2', capability: 'fence_only', samples: 3, nativeHits: 0, digest: '', checkedAt: 8 },
        { key: 'p2::m3', providerId: 'p2', model: 'm3', capability: 'unknown', samples: 0, nativeHits: 0, digest: '', checkedAt: 7 }
      ])
    )
    const r = await computeLocalJudgements({ readLiveVram: liveOk })
    expect(r.delegations.map((d) => d.key).sort()).toEqual(['p1::m1', 'p1::m2', 'p2::m3'])
    const ok = r.delegations.find((d) => d.key === 'p1::m1')!
    expect(ok).toMatchObject({ capability: 'native_tools_ok', samples: 3, nativeHits: 3, stale: false, delegationEnabled: false })
    // 反向对照：判定 ≠ 开关。上面那台是"能派活但用户没开"，不许被读成已启用
    expect(ok.delegationEnabled).toBe(false)
  })

  it('没有任何判定时是一行都不画，而不是画一排"未知"', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    const r = await computeLocalJudgements({ readLiveVram: liveOk })
    expect(r.delegations).toEqual([])
  })

  it('只读：这一趟不改助手表、不改 app_config（判据屏不许有写副作用）', async () => {
    configureLocalSlot({ readVramMiB: () => 4096 })
    appConfigRepo.set(
      'agent.delegate_capability',
      JSON.stringify([{ key: 'p1::m1', providerId: 'p1', model: 'm1', capability: 'unknown', samples: 0, nativeHits: 0, digest: '', checkedAt: 1 }])
    )
    const assistantsBefore = JSON.stringify(assistantRepo.list())
    const configBefore = appConfigRepo.get('agent.delegate_capability')
    await computeLocalJudgements({ readLiveVram: liveOk })
    expect(JSON.stringify(assistantRepo.list())).toBe(assistantsBefore)
    expect(appConfigRepo.get('agent.delegate_capability')).toBe(configBefore)
  })
})
