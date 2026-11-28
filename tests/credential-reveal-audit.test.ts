// SEC-16-11：凭据 reveal 通道的「审计 + 冷却 + 单次令牌」
//
// 三个验收面（audit 文档 2026-11 SEC-16-11）：
// · 每次 reveal 在 security_events 留痕（kind=credential_reveal，message/detail 不含密钥值）；
// · 重复 reveal 需重新取令牌（令牌消费一次即失效）；
// · 同一 id 60s 冷却，超限返回限流错误。
//
// 跑法：真 SQLite（内存库）承载 security_events，electron 桩捕获 ipcMain.handle 直接调
// registerProviderHandlers 注册的 handler；providerRepo/providerManager 桩掉（加密/网络边界，
// 与被测命题无关）。credential-reveal 守卫模块本身是纯内存实现，TTL/冷却用假时钟直接验。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3-multiple-ciphers'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (e: unknown, ...a: unknown[]) => unknown) => { mocks.handlers.set(ch, fn); return true } },
  BrowserWindow: class { static getAllWindows() { return [] } static fromWebContents() { return undefined } },
  dialog: { showErrorBox: () => {} },
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))

const mem = new Database(':memory:')
mem.exec(
  'CREATE TABLE security_events (id TEXT PRIMARY KEY, kind TEXT NOT NULL, message TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)'
)

vi.mock('../src/main/db/database', () => ({
  dbService: { getHandle: () => mem, isOpen: () => true, open: () => {}, close: () => {}, runMigrations: () => {} }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('../src/main/db/repositories/provider.repo', () => ({
  providerRepo: {
    list: () => [],
    save: (r: unknown) => r,
    delete: () => {},
    get: (id: string) => (id === 'p-glm' ? { id, apiKeys: ['sk-real-secret-value'] } : undefined)
  }
}))
vi.mock('../src/main/providers/manager', () => ({
  providerManager: { invalidate: () => {}, fetchModels: async () => [], test: async () => ({ ok: true }) }
}))

import { IPC } from '../src/shared/types'
import { registerProviderHandlers } from '../src/main/ipc/handlers/providers'
import {
  issueRevealToken,
  consumeRevealToken,
  revealCooldownOk,
  markRevealDone,
  resetRevealGuardForTest
} from '../src/main/ipc/credential-reveal'

registerProviderHandlers()

const askToken = async (): Promise<{ ok: boolean; token?: string }> =>
  (await mocks.handlers.get(IPC.PROVIDER_REQUEST_REVEAL_TOKEN)!({ sender: {} })) as { ok: boolean; token?: string }
const reveal = async (id: string, token: string): Promise<{ ok: boolean; apiKeys?: string[]; error?: string }> =>
  (await mocks.handlers.get(IPC.PROVIDER_REVEAL_KEYS)!({ sender: {} }, id, token)) as {
    ok: boolean
    apiKeys?: string[]
    error?: string
  }
const auditRows = (): Array<{ kind: string; message: string; detail: string | null }> =>
  mem.prepare('SELECT kind, message, detail FROM security_events ORDER BY created_at DESC, rowid DESC').all() as Array<{
    kind: string
    message: string
    detail: string | null
  }>

beforeEach(() => {
  mem.exec('DELETE FROM security_events')
  resetRevealGuardForTest()
})
afterEach(() => vi.useRealTimers())

describe('① 审计留痕', () => {
  it('成功 reveal ⇒ security_events 多一行 credential_reveal，message/detail 只说谁、不说密钥', async () => {
    const { token } = await askToken()
    const r = await reveal('p-glm', token!)
    expect(r.ok).toBe(true)
    expect(r.apiKeys).toEqual(['sk-real-secret-value'])

    const rows = auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('credential_reveal')
    expect(rows[0]!.message).toContain('p-glm')
    // 密钥值不许出现在任何审计字段里
    expect(rows[0]!.message).not.toContain('sk-real-secret-value')
    expect(rows[0]!.detail ?? '').not.toContain('sk-real-secret-value')
    expect(JSON.parse(rows[0]!.detail!)).toEqual({ providerId: 'p-glm' })
  })

  it('令牌无效/缺失 ⇒ 拒绝且**不留痕**（审计记的是"揭示发生了"，不是"有人想揭示"）', async () => {
    const r1 = await reveal('p-glm', '')
    const r2 = await reveal('p-glm', 'forged-token')
    expect(r1.ok).toBe(false)
    expect(r2.ok).toBe(false)
    expect(auditRows()).toHaveLength(0)
  })
})

describe('② 单次令牌', () => {
  it('冷却内同一令牌第二次兑换 ⇒ 先撞冷却闸（闸门顺序：冷却 → 令牌），不写第二条审计', async () => {
    const { token } = await askToken()
    expect((await reveal('p-glm', token!)).ok).toBe(true)
    const again = await reveal('p-glm', token!)
    expect(again.ok).toBe(false)
    expect(again.error).toContain('60 秒冷却')
    expect(auditRows()).toHaveLength(1)
  })

  it('冷却过期后用**同一枚**令牌重放 ⇒ 令牌闸拒绝（消费一次即失效，重放不了）', async () => {
    vi.useFakeTimers({ now: 0 })
    const { token } = await askToken()
    expect((await reveal('p-glm', token!)).ok).toBe(true)
    vi.advanceTimersByTime(61_000) // 冷却已过，排除冷却闸的干扰，单验令牌一次性
    const again = await reveal('p-glm', token!)
    expect(again.ok).toBe(false)
    expect(again.error).toContain('重新确认')
    expect(auditRows()).toHaveLength(1)
  })

  it('TTL 60s：过期令牌兑换失败（守卫模块直验）', () => {
    vi.useFakeTimers({ now: 0 })
    const token = issueRevealToken('provider')
    expect(consumeRevealToken('provider', token)).toBe(true)
    resetRevealGuardForTest()
    const token2 = issueRevealToken('provider')
    vi.advanceTimersByTime(61_000)
    expect(consumeRevealToken('provider', token2)).toBe(false)
  })

  it('通道隔离：provider 签发的令牌不能在 mcp 通道兑换', () => {
    const token = issueRevealToken('provider')
    expect(consumeRevealToken('mcp', token)).toBe(false)
  })
})

describe('③ 60s 冷却', () => {
  it('同一 id 第二次 reveal（新令牌）⇒ 限流错误，且不写第二条审计', async () => {
    const first = await askToken()
    expect((await reveal('p-glm', first.token!)).ok).toBe(true)
    const second = await askToken()
    const r = await reveal('p-glm', second.token!)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('60 秒冷却')
    expect(auditRows()).toHaveLength(1)
  })

  it('冷却只限同一 id：换一个 providerId 立即可揭示', async () => {
    const t1 = await askToken()
    expect((await reveal('p-glm', t1.token!)).ok).toBe(true)
    const t2 = await askToken()
    expect((await reveal('p-other', t2.token!)).ok).toBe(true)
    expect(auditRows()).toHaveLength(2)
  })

  it('冷却过期（>60s）后同一 id 可再次揭示（守卫模块直验）', () => {
    vi.useFakeTimers({ now: 0 })
    expect(revealCooldownOk('provider', 'p-glm')).toBe(true)
    markRevealDone('provider', 'p-glm')
    expect(revealCooldownOk('provider', 'p-glm')).toBe(false)
    expect(revealCooldownOk('provider', 'p-glm', 60_000)).toBe(true)
  })
})
