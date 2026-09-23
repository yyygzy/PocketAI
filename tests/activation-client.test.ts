// 在线激活客户端错误分类测试：
// 用 fetch 桩模拟网络层，用 licenseService 桩模拟本地验签，
// 验证每种失败路径都返回稳定的 ActivationErrorCode（渲染端据此走 i18n 提示）。
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/main/license/license', () => ({
  licenseService: { loadFromString: vi.fn() }
}))

import { activateOnline } from '../src/main/license/activation-client'
import { licenseService } from '../src/main/license/license'
import type { ActivationErrorCode, LicenseStatus } from '../src/shared/types'

const loadMock = vi.mocked(licenseService.loadFromString)
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)

const FP = 'aaaabbbbccccdddd'

function jsonRes(status: number, body?: unknown, jsonImpl?: () => Promise<unknown>) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: jsonImpl ?? (() => Promise.resolve(body))
  } as unknown as Response
}

function expectFail(result: Awaited<ReturnType<typeof activateOnline>>, code: ActivationErrorCode) {
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.code).toBe(code)
}

describe('activateOnline — 本地前置检查', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    loadMock.mockReset()
  })

  it('空卡密 / 纯空白 → EMPTY_CODE，且不发请求', async () => {
    expectFail(await activateOnline('', FP), 'EMPTY_CODE')
    expectFail(await activateOnline('   ', FP), 'EMPTY_CODE')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('读不到硬盘指纹 → FINGERPRINT_UNAVAILABLE', async () => {
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', null), 'FINGERPRINT_UNAVAILABLE')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('activateOnline — 网络层', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    loadMock.mockReset()
  })

  it('断网 / 拒绝连接（fetch 抛 TypeError）→ NETWORK_UNREACHABLE', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('fetch failed'), { name: 'TypeError' }))
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), 'NETWORK_UNREACHABLE')
  })

  it('超时中止（AbortError）→ NETWORK_TIMEOUT', async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), 'NETWORK_TIMEOUT')
  })

  it('请求体带 trimmed 卡密与指纹，POST 到 /v1/activate', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(404, { ok: false, code: 'CODE_NOT_FOUND' }))
    await activateOnline('  PA-AAAA-BBBB-CCCC  ', FP)
    const call = fetchMock.mock.calls[0]
    if (!call) throw new Error('fetch 未被调用')
    const [url, init] = call
    expect(String(url).endsWith('/v1/activate')).toBe(true)
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ code: 'PA-AAAA-BBBB-CCCC', fingerprint: FP })
  })
})

describe('activateOnline — 服务端错误码映射', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    loadMock.mockReset()
  })

  const cases: Array<[number, { ok: boolean; code: string }, ActivationErrorCode]> = [
    [404, { ok: false, code: 'CODE_NOT_FOUND' }, 'CODE_NOT_FOUND'],
    [403, { ok: false, code: 'ALREADY_BOUND_OTHER' }, 'ALREADY_BOUND_OTHER'],
    [400, { ok: false, code: 'CODE_FORMAT_INVALID' }, 'CODE_FORMAT_INVALID'],
    [400, { ok: false, code: 'FINGERPRINT_INVALID' }, 'FINGERPRINT_INVALID'],
    [429, { ok: false, code: 'CODE_LOCKED' }, 'CODE_LOCKED'],
    [429, { ok: false, code: 'RATE_LIMITED' }, 'RATE_LIMITED'],
    [500, { ok: false, code: 'ISSUE_FAILED' }, 'ISSUE_FAILED']
  ]
  for (const [status, body, expected] of cases) {
    it(`${status} ${body.code} → ${expected}`, async () => {
      fetchMock.mockResolvedValueOnce(jsonRes(status, body))
      expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), expected)
    })
  }

  it('429 但响应体无 code → 按状态码兜底 RATE_LIMITED', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(429, { ok: false, error: 'slow down' }))
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), 'RATE_LIMITED')
  })

  it('未知 code（防伪造新码提权）→ SERVER_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(403, { ok: false, code: 'MAKE_ME_ENTERPRISE' })
    )
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), 'SERVER_ERROR')
  })

  it('400 无 code → SERVER_ERROR（detail 带服务端原文便于排查）', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(400, { ok: false, error: 'bad request' }))
    const r = await activateOnline('PA-AAAA-BBBB-CCCC', FP)
    expectFail(r, 'SERVER_ERROR')
    if (!r.ok) expect(r.detail).toBe('bad request')
  })

  it('响应体 JSON 损坏 + 503 → SERVER_ERROR（不抛异常）', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonRes(503, undefined, () => Promise.reject(new Error('invalid json')))
    )
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), 'SERVER_ERROR')
  })

  it('ok:true 但缺 license 字段 → SERVER_ERROR', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { ok: true }))
    expectFail(await activateOnline('PA-AAAA-BBBB-CCCC', FP), 'SERVER_ERROR')
    expect(loadMock).not.toHaveBeenCalled()
  })
})

describe('activateOnline — 本地验签与成功路径', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    loadMock.mockReset()
  })

  it('下发 license 未通过验签 → INVALID_LICENSE（且不向上抛）', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { ok: true, license: 'TAMPERED' }))
    loadMock.mockReturnValueOnce({
      valid: false,
      signatureOk: true,
      expired: false,
      error: 'License 与当前硬盘不匹配'
    })
    const r = await activateOnline('PA-AAAA-BBBB-CCCC', FP)
    expectFail(r, 'INVALID_LICENSE')
    if (!r.ok) expect(r.detail).toContain('硬盘不匹配')
  })

  it('验签通过 → ok:true，回传 status 与 license 原文（供落盘）', async () => {
    fetchMock.mockResolvedValueOnce(jsonRes(200, { ok: true, license: 'LIC-JSON' }))
    const status: LicenseStatus = {
      valid: true,
      signatureOk: true,
      expired: false,
      payload: {
        version: 1,
        license_id: 'lic-1',
        owner: '张三',
        issued_at: 0,
        expires_at: 4_102_444_800_000,
        plan: 'pro',
        features: []
      }
    }
    loadMock.mockReturnValueOnce(status)
    const r = await activateOnline('PA-AAAA-BBBB-CCCC', FP)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.license).toBe('LIC-JSON')
      expect(r.status).toBe(status)
    }
  })
})
