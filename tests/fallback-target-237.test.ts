// @vitest-environment node
// V4-Iter-237 的输入层：备用表「能存什么、不能存什么」。
//
// 分两层写在一份文件里是有意的：归一化是纯函数（脏 JSON 退成空表、指向自己丢掉），
// 而"存进去再读回来"要真库才证得到（app_config 那条 JSON 往返、上限那条不写坏表）。
// 纯函数测过 ≠ 接上过（§232 那轮补的就是这条），所以每条纯函数判据旁边都配一条走库的。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-237-prefs'
  return { dir, db: dir + sep + 'app.db', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: P.data,
  DB_PATH: P.db,
  MCP_EXTENSIONS_DIR: P.data + '/mcp',
  isPortable: () => false,
  portableDataDir: () => P.data
}))

vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import {
  getFallbackTarget,
  listFallbackTargets,
  setFallbackTarget
} from '../src/main/agent/fallback-target-prefs'
import {
  FALLBACK_MAX_ENTRIES,
  fallbackTargetKey,
  isFallbackPart,
  normalizeFallbackTargets
} from '../src/shared/fallback-target'

const K = 'agent.fallback_targets'

beforeAll(() => {
  fs.rmSync(P.dir, { recursive: true, force: true })
  fs.mkdirSync(P.data, { recursive: true })
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

beforeEach(() => {
  // 每条用例从空表起。必须走 `appConfigRepo.set`：那个仓储有一层内存 cache，
  // 直接 DELETE 会让 cache 里还留着上一条用例设的那份 ⇒ "清干净"变成假绿（第一版就红在这）
  appConfigRepo.set(K, '{}')
})

describe('纯函数那一层：什么能进表、什么必须被丢掉', () => {
  it('可用的键/段：非空、不含 ::、不超长', () => {
    expect(isFallbackPart('glm')).toBe(true)
    expect(isFallbackPart('  ')).toBe(false)
    expect(isFallbackPart('')).toBe(false)
    expect(isFallbackPart('a::b')).toBe(false)
    expect(isFallbackPart('x'.repeat(129))).toBe(false)
  })

  it('脏表逐条丢：无 :: 的键、空段、值不是对象、值缺 model、指向自己', () => {
    const out = normalizeFallbackTargets({
      'plainkey': { providerId: 'p', model: 'm' },
      [fallbackTargetKey('', 'm')]: { providerId: 'p', model: 'm' },
      [fallbackTargetKey('p', 'm')]: 'not-an-object',
      [fallbackTargetKey('p', 'm2')]: { providerId: 'p' },
      [fallbackTargetKey('p', 'self')]: { providerId: 'p', model: 'self' },
      [fallbackTargetKey('q', 'ok')]: { providerId: 'r', model: 'y' }
    })
    expect(Object.keys(out)).toEqual([fallbackTargetKey('q', 'ok')])
  })

  it('一条都不合法时退成空表，而不是抛（app_config 里可能是手改坏的 JSON）', () => {
    expect(normalizeFallbackTargets(null)).toEqual({})
    expect(normalizeFallbackTargets([])).toEqual({})
    expect(normalizeFallbackTargets('x')).toEqual({})
  })
})

describe('走库那一层：设/覆盖/清，以及拒绝时不动库', () => {
  it('设一台再读回来；没设过的那台读到 null', () => {
    const r = setFallbackTarget('glm', 'glm-4.6', { providerId: 'ollama', model: 'qwen3:1.7b' })
    expect(r.rejected).toBeUndefined()
    expect(r.targets[fallbackTargetKey('glm', 'glm-4.6')]).toEqual({ providerId: 'ollama', model: 'qwen3:1.7b' })
    expect(getFallbackTarget('glm', 'glm-4.7')).toBeNull()
    // 真落库：直接读 app_config，而不是只信返回值
    expect(JSON.parse(appConfigRepo.get(K) ?? '{}')).toHaveProperty(fallbackTargetKey('glm', 'glm-4.6'))
  })

  it('同一台再设一次是覆盖，不是多出一条；清除后读不到', () => {
    setFallbackTarget('glm', 'm', { providerId: 'a', model: 'x' })
    const again = setFallbackTarget('glm', 'm', { providerId: 'b', model: 'y' })
    expect(Object.keys(again.targets)).toHaveLength(1)
    expect(again.targets[fallbackTargetKey('glm', 'm')]).toEqual({ providerId: 'b', model: 'y' })
    const cleared = setFallbackTarget('glm', 'm', null)
    expect(Object.keys(cleared.targets)).toHaveLength(0)
    expect(getFallbackTarget('glm', 'm')).toBeNull()
  })

  it('清除一条本来就不存在的备用 ⇒ 原样不动（别把"没改动"演成"改过了"）', () => {
    const before = appConfigRepo.get(K)
    const r = setFallbackTarget('glm', 'none-here', null)
    expect(r.rejected).toBeUndefined()
    expect(Object.keys(r.targets)).toHaveLength(0)
    expect(appConfigRepo.get(K)).toBe(before)
  })

  it('键含 :: 的 id 被拒，且原样不动', () => {
    const before = appConfigRepo.get(K)
    const r = setFallbackTarget('a::b', 'm', { providerId: 'c', model: 'd' })
    expect(r.rejected).toBe('FALLBACK_INVALID_ID')
    expect(appConfigRepo.get(K)).toBe(before)
  })

  it('备用指向自己 ⇒ 拒，且原样不动', () => {
    const before = appConfigRepo.get(K)
    const r = setFallbackTarget('glm', 'm', { providerId: 'glm', model: 'm' })
    expect(r.rejected).toBe('FALLBACK_IS_SELF')
    expect(appConfigRepo.get(K)).toBe(before)
  })

  it(`表满 ${FALLBACK_MAX_ENTRIES} 条时再多设 ⇒ 拒并保持原表（不许静默丢一条）`, () => {
    const full: Record<string, { providerId: string; model: string }> = {}
    for (let i = 0; i < FALLBACK_MAX_ENTRIES; i++) {
      full[fallbackTargetKey(`p${i}`, 'm')] = { providerId: 'q', model: 'x' }
    }
    appConfigRepo.set(K, JSON.stringify(full))
    expect(Object.keys(listFallbackTargets())).toHaveLength(FALLBACK_MAX_ENTRIES)
    const r = setFallbackTarget('brand-new', 'm', { providerId: 'q', model: 'x' })
    expect(r.rejected).toBe('FALLBACK_INVALID_TARGET')
    // 拒绝时回传的还是那张原表，库也没被写坏
    expect(Object.keys(r.targets)).toHaveLength(FALLBACK_MAX_ENTRIES)
    expect(listFallbackTargets()[fallbackTargetKey('brand-new', 'm')]).toBeUndefined()
  })

  it('app_config 里是坏 JSON ⇒ 读成空表，不抛（下一发设值还能覆盖掉它）', () => {
    appConfigRepo.set(K, '{this is not json')
    expect(listFallbackTargets()).toEqual({})
    expect(getFallbackTarget('glm', 'm')).toBeNull()
    const r = setFallbackTarget('glm', 'm', { providerId: 'q', model: 'x' })
    expect(Object.keys(r.targets)).toHaveLength(1)
  })

  it('已存表里"指向自己"那一条在读取时被丢掉（历史脏数据不能变成一次没换的换）', () => {
    appConfigRepo.set(
      K,
      JSON.stringify({ [fallbackTargetKey('glm', 'm')]: { providerId: 'glm', model: 'm' } })
    )
    expect(getFallbackTarget('glm', 'm')).toBeNull()
  })
})
