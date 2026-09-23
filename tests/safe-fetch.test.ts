// safeFetch SSRF 防护校验测试
//
// 覆盖 safe-fetch.ts 的 5 个已导出纯函数（原为模块内部函数，为可测性小幅 export）：
//   - isDisallowedIpv4：IPv4 是否落在禁止网段（环回/私网/链路本地/保留/组播）
//   - expandIpv6：IPv6 展开为 8 hextet，兼容 :: 压缩与尾部点分 IPv4
//   - isDisallowedIpv6：IPv6 禁止网段，含 IPv4-mapped / NAT64 / 6to4 内嵌递归校验
//   - isDisallowedIp：按地址族分派（v4/v6/非 IP 一律拒）
//   - assertFetchable：URL 协议白名单（仅 http/https）+ 主机名必填
//
// 策略：纯函数直接断言，无需 mock。SSRF 防护是安全关键路径，
// asar-patcher.test.ts 里 safeFetch 仅作 mock 占位，真实实现零覆盖。
import { describe, it, expect } from 'vitest'
import {
  isDisallowedIpv4,
  expandIpv6,
  isDisallowedIpv6,
  isDisallowedIp,
  assertFetchable,
  SafeFetchError
} from '../src/main/net/safe-fetch'

describe('isDisallowedIpv4 — IPv4 禁止网段', () => {
  it('环回 127.0.0.0/8 → true', () => {
    expect(isDisallowedIpv4('127.0.0.1')).toBe(true)
    expect(isDisallowedIpv4('127.255.255.255')).toBe(true)
  })

  it('私网 10/8、172.16-31/12、192.168/16 → true', () => {
    expect(isDisallowedIpv4('10.0.0.1')).toBe(true)
    expect(isDisallowedIpv4('172.16.0.1')).toBe(true)
    expect(isDisallowedIpv4('172.31.255.255')).toBe(true)
    expect(isDisallowedIpv4('192.168.1.1')).toBe(true)
  })

  it('链路本地 169.254/16（含云元数据 169.254.169.254）→ true', () => {
    expect(isDisallowedIpv4('169.254.0.1')).toBe(true)
    expect(isDisallowedIpv4('169.254.169.254')).toBe(true)
  })

  it('其他保留段：0/8、CGNAT 100.64-127、192.0.2/24、203.0.113/24、198.18/15、组播 224+ → true', () => {
    expect(isDisallowedIpv4('0.0.0.0')).toBe(true)
    expect(isDisallowedIpv4('100.64.0.1')).toBe(true)
    expect(isDisallowedIpv4('100.127.255.255')).toBe(true)
    expect(isDisallowedIpv4('192.0.2.1')).toBe(true)
    expect(isDisallowedIpv4('203.0.113.1')).toBe(true)
    expect(isDisallowedIpv4('198.18.0.1')).toBe(true)
    expect(isDisallowedIpv4('224.0.0.1')).toBe(true)
    expect(isDisallowedIpv4('255.255.255.255')).toBe(true)
  })

  it('公网地址 → false；非法格式 → true', () => {
    expect(isDisallowedIpv4('8.8.8.8')).toBe(false)
    expect(isDisallowedIpv4('1.1.1.1')).toBe(false)
    expect(isDisallowedIpv4('114.114.114.114')).toBe(false)
    // 非法格式一律拒绝（防绕过）
    expect(isDisallowedIpv4('1.2.3')).toBe(true)
    expect(isDisallowedIpv4('256.0.0.1')).toBe(true)
    expect(isDisallowedIpv4('abc')).toBe(true)
  })
})

describe('expandIpv6 — IPv6 展开', () => {
  it('::1 → 环回（末位为 1）', () => {
    expect(expandIpv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
  })

  it('::ffff:192.0.2.1 → 内嵌 IPv4 展开为两个 hextet', () => {
    // 192=0xc0,0=0x00 → 0xc000；2=0x02,1=0x01 → 0x0201
    expect(expandIpv6('::ffff:192.0.2.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201])
  })

  it('2001:db8::1 → :: 压缩展开补零', () => {
    expect(expandIpv6('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
  })

  it('非法输入 → null（非十六进制、多个 ::）', () => {
    expect(expandIpv6('gggg::1')).toBe(null)
    expect(expandIpv6('1:2:3:4:5:6:7:8:9')).toBe(null) // 超过 8 段
    expect(expandIpv6('1::2::3')).toBe(null) // 多个 ::
  })
})

describe('isDisallowedIpv6 — IPv6 禁止网段', () => {
  it('::1 环回 → true；:: 未指定 → true', () => {
    expect(isDisallowedIpv6('::1')).toBe(true)
    expect(isDisallowedIpv6('::')).toBe(true)
  })

  it('IPv4-mapped ::ffff:127.0.0.1 → 递归判内嵌 IPv4 为 true', () => {
    expect(isDisallowedIpv6('::ffff:127.0.0.1')).toBe(true)
    expect(isDisallowedIpv6('::ffff:169.254.169.254')).toBe(true)
  })

  it('NAT64 64:ff9b::/96 内嵌私网 IPv4 → true', () => {
    expect(isDisallowedIpv6('64:ff9b::127.0.0.1')).toBe(true)
  })

  it('链路本地 fe80::/10、ULA fc00::/7、组播 ff00::/8、文档段 2001:db8::/32 → true', () => {
    expect(isDisallowedIpv6('fe80::1')).toBe(true)
    expect(isDisallowedIpv6('fd00::1')).toBe(true)
    expect(isDisallowedIpv6('ff00::1')).toBe(true)
    expect(isDisallowedIpv6('2001:db8::1')).toBe(true)
  })

  it('公网 IPv6（Cloudflare 2606:4700::1111）→ false；解析失败 → true', () => {
    expect(isDisallowedIpv6('2606:4700:4700::1111')).toBe(false)
    expect(isDisallowedIpv6('not-an-ip')).toBe(true)
  })
})

describe('isDisallowedIp — 地址族分派', () => {
  it('IPv4 字面 → 走 isDisallowedIpv4；IPv6 字面 → 走 isDisallowedIpv6；非 IP → true', () => {
    // IPv4 公网放行
    expect(isDisallowedIp('8.8.8.8')).toBe(false)
    // IPv4 环回拦截
    expect(isDisallowedIp('127.0.0.1')).toBe(true)
    // IPv6 公网放行
    expect(isDisallowedIp('2606:4700:4700::1111')).toBe(false)
    // IPv6 环回拦截
    expect(isDisallowedIp('::1')).toBe(true)
    // 非 IP 字符串一律拒绝
    expect(isDisallowedIp('example.com')).toBe(true)
    expect(isDisallowedIp('')).toBe(true)
  })
})

describe('assertFetchable — URL 协议白名单', () => {
  it('http/https → 不抛', () => {
    expect(() => assertFetchable(new URL('http://example.com/'))).not.toThrow()
    expect(() => assertFetchable(new URL('https://example.com/path'))).not.toThrow()
  })

  it('ftp/file 协议 → 抛 SafeFetchError（协议非白名单）', () => {
    expect(() => assertFetchable(new URL('ftp://example.com/file'))).toThrow(SafeFetchError)
    expect(() => assertFetchable(new URL('file:///etc/passwd'))).toThrow(SafeFetchError)
  })

  it('javascript: 协议 → 抛 SafeFetchError', () => {
    expect(() => assertFetchable(new URL('javascript:alert(1)'))).toThrow(SafeFetchError)
  })
})
