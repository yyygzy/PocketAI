// 渲染层外链白名单 + 平台网关回调地址校验（SEC-27 / SEC-23）
import { describe, it, expect } from 'vitest'
import { safeHttpHref } from '../src/renderer/src/utils/external-url'
import { assertGatewaySocketUrl } from '../src/main/channels/gateway-base'

describe('safeHttpHref — 远端返回值的链接降级', () => {
  it('http(s) 绝对地址通过', () => {
    expect(safeHttpHref('https://github.com/x/releases/v1')).toContain('https://github.com')
    expect(safeHttpHref('http://example.com/a')).toContain('http://example.com')
  })

  it('非 http(s) / 畸形 / 非字符串 → null（调用方不渲染成链接）', () => {
    for (const v of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      '//evil.example/x',
      'mailto:a@b.c',
      'github.com/no-scheme',
      '',
      '   ',
      null,
      undefined,
      42
    ]) {
      expect(safeHttpHref(v), String(v)).toBeNull()
    }
  })
})

describe('assertGatewaySocketUrl — 服务端下发地址（SEC-23）', () => {
  it('wss 放行并规范化', () => {
    expect(assertGatewaySocketUrl('wss://gw.dingtalk.com/connect', '钉钉')).toContain('wss://')
  })

  it('ws 仅本机回环例外（本地联调）', () => {
    expect(assertGatewaySocketUrl('ws://localhost:8080/ws', 'dev')).toContain('ws://localhost')
    expect(assertGatewaySocketUrl('ws://127.0.0.1:8080/ws', 'dev')).toContain('127.0.0.1')
    expect(() => assertGatewaySocketUrl('ws://evil.example/ws', 'x')).toThrow(/协议不被允许/)
  })

  it('明文/危险协议与畸形地址一律抛错', () => {
    for (const bad of ['http://evil/x', 'file:///etc/passwd', 'javascript:alert(1)', '', 'not-a-url']) {
      expect(() => assertGatewaySocketUrl(bad, 'x'), bad).toThrow()
    }
  })
})
