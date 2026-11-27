// v2 全局出网 allowlist 的纯函数闸门：默认关闭、开启后 fail-closed、逐跳复用。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  assertOutboundHostAllowed,
  isOutboundHostAllowed,
  normalizeOutboundHost,
  normalizeOutboundSitePolicy,
  resetOutboundPolicyReader
} from '../src/main/net/outbound-policy'

beforeEach(() => resetOutboundPolicyReader())

describe('出网 allowlist 规范化', () => {
  it('hostname 去协议/端口/路径并小写', () => {
    expect(normalizeOutboundHost('HTTPS://API.Example.com:443/v1?x=1')).toBe('api.example.com')
    expect(normalizeOutboundHost('  Example.COM  ')).toBe('example.com')
    expect(normalizeOutboundHost('')).toBe('')
  })

  it('策略里的非法/重复 host 被丢掉，且按小写去重', () => {
    const p = normalizeOutboundSitePolicy({
      enabled: true,
      allowedHosts: [' https://A.com:443/x ', 'a.com', '', 'b.example', 42]
    })
    expect(p).toEqual({ enabled: true, allowedHosts: ['a.com', 'b.example'] })
  })
})

describe('出网 allowlist 判定', () => {
  it('默认关闭时任何合法 host 都放行', () => {
    expect(isOutboundHostAllowed('anything.example.com', { enabled: false, allowedHosts: [] })).toBe(true)
  })

  it('开启后只放行名单内 host，空名单拦全部', () => {
    const policy = { enabled: true, allowedHosts: ['allowed.example.com'] }
    expect(isOutboundHostAllowed('allowed.example.com', policy)).toBe(true)
    expect(isOutboundHostAllowed('ALLOWED.example.com:443', policy)).toBe(true)
    expect(isOutboundHostAllowed('blocked.example.com', policy)).toBe(false)
    expect(isOutboundHostAllowed('', policy)).toBe(false)
    expect(() => assertOutboundHostAllowed(new URL('https://blocked.example.com/x'), policy)).toThrow(
      /不在 allowlist/
    )
  })
})
