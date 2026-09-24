// shell-config 终端策略配置测试
//
// 覆盖 src/main/tools/shell-config.ts：
// getShellConfig 默认安全降级（缺省/非法值→confirm、非'1'→false）、
// setShellConfig roundtrip / 部分字段写入 / zod 拒绝非法输入不落库。
//
// 策略：mock appConfigRepo（KV Map + 写入计数），shellConfigSchema 走真实 zod 校验。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/db/repositories/app-config.repo', () => {
  const kv = new Map<string, string>()
  const writes: string[] = []
  return {
    appConfigRepo: {
      get: (key: string) => kv.get(key) ?? null,
      set: (key: string, value: string) => {
        kv.set(key, value)
        writes.push(key)
      }
    },
    __kv: kv,
    __writes: writes
  }
})

import { getShellConfig, setShellConfig } from '../src/main/tools/shell-config'
import * as repoMod from '../src/main/db/repositories/app-config.repo'
const repo = repoMod as unknown as { __kv: Map<string, string>; __writes: string[] }

beforeEach(() => {
  repo.__kv.clear()
  repo.__writes.length = 0
})

describe('getShellConfig — 读取与安全降级', () => {
  it('KV 全空 → 默认关闭 + confirm（默认安全）', () => {
    expect(getShellConfig()).toEqual({ enabled: false, policy: 'confirm' })
  })

  it("enabled='1' + policy='auto-safe' → 正确读取", () => {
    repo.__kv.set('agent.shell_enabled', '1')
    repo.__kv.set('agent.shell_policy', 'auto-safe')
    expect(getShellConfig()).toEqual({ enabled: true, policy: 'auto-safe' })
  })

  it("enabled 非 '1'（'0'/其它）→ 关闭；policy 非法值 → 回退 confirm", () => {
    repo.__kv.set('agent.shell_enabled', '0')
    repo.__kv.set('agent.shell_policy', 'yolo')
    expect(getShellConfig()).toEqual({ enabled: false, policy: 'confirm' })

    repo.__kv.set('agent.shell_enabled', 'yes')
    repo.__kv.set('agent.shell_policy', '')
    expect(getShellConfig()).toEqual({ enabled: false, policy: 'confirm' })
  })
})

describe('setShellConfig — 写入与校验', () => {
  it('roundtrip：写入 auto-safe + 开启后读回一致', () => {
    const result = setShellConfig({ enabled: true, policy: 'auto-safe' })
    expect(result).toEqual({ enabled: true, policy: 'auto-safe' })
  })

  it('部分字段写入：只传 enabled 不动 policy', () => {
    repo.__kv.set('agent.shell_policy', 'auto-safe')
    setShellConfig({ enabled: true })
    expect(repo.__writes).toEqual(['agent.shell_enabled']) // 只写了一个 key
    expect(getShellConfig()).toEqual({ enabled: true, policy: 'auto-safe' })
  })

  it('非法 policy 被 zod 拒绝抛 ZodError，且不落库', () => {
    expect(() => setShellConfig({ policy: 'yolo' as never })).toThrowError()
    expect(repo.__writes).toHaveLength(0)
  })

  it('空对象 → 不写任何 key，返回当前配置', () => {
    const result = setShellConfig({})
    expect(repo.__writes).toHaveLength(0)
    expect(result).toEqual({ enabled: false, policy: 'confirm' })
  })

  it("关闭开关写入 '0'，读回 enabled=false", () => {
    repo.__kv.set('agent.shell_enabled', '1')
    setShellConfig({ enabled: false })
    expect(repo.__kv.get('agent.shell_enabled')).toBe('0')
    expect(getShellConfig().enabled).toBe(false)
  })
})
