// 飞书长连接回调 URL 校验（H2）：平台响应的 url 必须经官方域名白名单收口后才能建连，
// 否则随后携带的 tenant token 会外送到攻击者控制的 WebSocket 端点。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getChannelSecretsMock = vi.fn()
const fetchWithTimeoutMock = vi.fn()

vi.mock('../src/main/channels/channel-config', () => ({
  getChannelSecrets: (...args: unknown[]) => getChannelSecretsMock(...args)
}))

vi.mock('../src/main/channels/gateway-base', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/channels/gateway-base')>()
  return {
    ...actual,
    fetchWithTimeout: (...args: unknown[]) => fetchWithTimeoutMock(...args)
  }
})

import { feishuGateway } from '../src/main/channels/feishu-gateway'

const originalWebSocket = globalThis.WebSocket

let createdUrls: string[] = []

class FakeWebSocket {
  static readonly OPEN = 1
  readonly OPEN = 1
  readyState = 1
  constructor(url: string) {
    createdUrls.push(url)
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
  send(): void {}
}

function mockPlatformResponses(wsUrl: unknown): void {
  fetchWithTimeoutMock
    .mockReset()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ tenant_access_token: 'tenant-token' }), { status: 200 })
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { url: wsUrl } }), { status: 200 })
    )
}

beforeEach(() => {
  createdUrls = []
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket
  getChannelSecretsMock.mockReset().mockReturnValue({
    appId: 'cli_test',
    primary: '',
    secondary: 'app-secret',
    whitelist: []
  })
  fetchWithTimeoutMock.mockReset()
})

afterEach(() => {
  feishuGateway.stop()
  globalThis.WebSocket = originalWebSocket
})

describe('飞书网关 WS 回调地址', () => {
  for (const badUrl of [
    'ws://attacker.example/ws',
    'wss://attacker.example/ws',
    'wss://127.0.0.1/ws',
    'wss://evil-feishu.cn/ws',
    42,
    null
  ]) {
    it(`平台返回 ${String(badUrl)} → 拒绝建连，凭据不发出`, async () => {
      mockPlatformResponses(badUrl)
      await expect(feishuGateway.start(() => {})).rejects.toThrow()
      expect(createdUrls).toEqual([])
    })
  }

  it('平台返回合法 wss://open.feishu.cn → 正常建连', async () => {
    mockPlatformResponses('wss://open.feishu.cn/ws')
    await feishuGateway.start(() => {})
    expect(createdUrls).toEqual(['wss://open.feishu.cn/ws'])
  })

  it('平台返回合法 wss://open.larksuite.com → 正常建连', async () => {
    mockPlatformResponses('wss://open.larksuite.com/ws')
    await feishuGateway.start(() => {})
    expect(createdUrls).toEqual(['wss://open.larksuite.com/ws'])
  })
})
