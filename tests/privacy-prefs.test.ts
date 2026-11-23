// 隐私/离线模式回归：fail-safe 语义 + 拦截点源码闸门。
// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>()
  const providers = new Map<string, { id: string; baseUrl: string; enabled: boolean; name: string }>()
  return {
    store, providers,
    appConfigRepo: {
      get: (k: string) => store.get(k) ?? null,
      set: (k: string, v: string) => { store.set(k, v) }
    },
    providerRepo: {
      get: (id: string) => providers.get(id) ?? undefined
    }
  }
})

vi.mock('../src/main/db/repositories/app-config.repo', () => ({ appConfigRepo: mocks.appConfigRepo }))
vi.mock('../src/main/db/repositories/provider.repo', () => ({ providerRepo: mocks.providerRepo }))

import {
  isPrivacyModeEnabled, setPrivacyMode, isProviderAllowedUnderPrivacy, getPrivacyMode
} from '../src/main/agent/privacy-prefs'

function putProvider(id: string, baseUrl: string) {
  mocks.providers.set(id, { id, baseUrl, enabled: true, name: id })
}

describe('隐私模式 fail-safe 语义', () => {
  it('缺省（未配置）→ 开启；只有显式 0 才关闭', () => {
    mocks.store.clear()
    expect(isPrivacyModeEnabled()).toBe(true)
    expect(getPrivacyMode()).toEqual({ enabled: true })
    setPrivacyMode(false)
    expect(isPrivacyModeEnabled()).toBe(false)
    mocks.store.set('agent.privacy_mode', 'garbage')
    expect(isPrivacyModeEnabled()).toBe(true) // 任何非 '0' 都按开
  })

  it('设置写入：开→1 关→0', () => {
    expect(setPrivacyMode(true)).toBe(true)
    expect(mocks.store.get('agent.privacy_mode')).toBe('1')
    expect(setPrivacyMode(false)).toBe(true)
    expect(mocks.store.get('agent.privacy_mode')).toBe('0')
  })
})

describe('隐私模式下 provider 放行判定（只认回环，判不出按拒绝）', () => {
  it('隐私关闭 → 全部放行', () => {
    setPrivacyMode(false)
    putProvider('cloud', 'https://api.openai.com/v1')
    expect(isProviderAllowedUnderPrivacy('cloud')).toBe(true)
  })

  it('隐私开启 → 回环放行，云端拒绝，判不出/空 URL 拒绝', () => {
    setPrivacyMode(true)
    putProvider('local', 'http://127.0.0.1:11434/v1')
    putProvider('localhost', 'http://localhost:11434/v1')
    putProvider('cloud', 'https://api.openai.com/v1')
    putProvider('lan', 'http://192.168.1.10:11434/v1')
    putProvider('empty', '')
    expect(isProviderAllowedUnderPrivacy('local')).toBe(true)
    expect(isProviderAllowedUnderPrivacy('localhost')).toBe(true)
    expect(isProviderAllowedUnderPrivacy('cloud')).toBe(false)
    expect(isProviderAllowedUnderPrivacy('lan')).toBe(false)
    expect(isProviderAllowedUnderPrivacy('empty')).toBe(false)
    expect(isProviderAllowedUnderPrivacy('missing')).toBe(false)
  })
})

describe('拦截点源码闸门', () => {
  const engine = readFileSync('src/main/agent/engine.ts', 'utf8')
  const manager = readFileSync('src/main/providers/manager.ts', 'utf8')
  const ollamaHandler = readFileSync('src/main/ipc/handlers/ollama.ts', 'utf8')

  it('引擎主闸门在任何状态登记之前拒绝云端', () => {
    expect(engine).toContain('isProviderAllowedUnderPrivacy(target.providerId)')
    expect(engine).toContain('PRIVACY_MODE_BLOCKED_CLOUD')
    // 主闸门必须早于 activeConversations.set（§307 顺序）
    const gate = engine.indexOf('isProviderAllowedUnderPrivacy(target.providerId)')
    const busy = engine.indexOf('this.activeConversations.set(conversationId, requestId)')
    expect(gate).toBeGreaterThan(0)
    expect(busy).toBeGreaterThan(gate)
  })

  it('委派候选也注入隐私谓辞', () => {
    expect(engine).toContain('isProviderAllowedUnderPrivacy(candidate.providerId)')
  })

  it('manager 纵深守卫用注入模式（不顶层拉 app_config 链）', () => {
    expect(manager).toContain('setPrivacyGuardResolver')
    expect(manager).toContain('this.privacyGuardResolver(id)')
    expect(manager).not.toContain('privacy-prefs')
    expect(ollamaHandler).toContain('setPrivacyGuardResolver')
  })
})
