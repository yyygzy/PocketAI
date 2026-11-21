// M2：激活服务器地址强制 HTTPS（仅回环允许 http）+ 卡密 POST 禁止重定向
import { describe, it, expect, vi, afterEach } from 'vitest'

const ORIGINAL = process.env['POCKETAI_LICENSE_URL']

async function loadConfig(env?: string) {
  vi.resetModules()
  if (env === undefined) delete process.env['POCKETAI_LICENSE_URL']
  else process.env['POCKETAI_LICENSE_URL'] = env
  return import('../src/main/license/server-config')
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['POCKETAI_LICENSE_URL']
  else process.env['POCKETAI_LICENSE_URL'] = ORIGINAL
  vi.unstubAllGlobals()
})

describe('激活服务器地址（server-config）', () => {
  it('未设置环境变量 → 本机开发默认值', async () => {
    const { ACTIVATION_BASE_URL } = await loadConfig()
    expect(ACTIVATION_BASE_URL).toBe('http://127.0.0.1:8787')
  })

  it('正式域名 https → 放行', async () => {
    const { ACTIVATION_BASE_URL } = await loadConfig('https://license.example.com/')
    expect(ACTIVATION_BASE_URL).toBe('https://license.example.com')
  })

  it('本机回环 http → 保留本地开发可用性', async () => {
    const { ACTIVATION_BASE_URL } = await loadConfig('http://localhost:8787')
    expect(ACTIVATION_BASE_URL).toBe('http://localhost:8787')
  })

  it('公网 http 与畸形地址 → 导入即抛错，拒绝启动', async () => {
    await expect(loadConfig('http://license.example.com')).rejects.toThrow(/https/)
    await expect(loadConfig('file:///etc/passwd')).rejects.toThrow()
  })
})

describe('卡密请求（activation-client）', () => {
  it('POST 显式 redirect:error，不跟随跳转到内网/明文端点', async () => {
    vi.resetModules()
    process.env['POCKETAI_LICENSE_URL'] = 'https://license.example.com'
    vi.doMock('../src/main/license/license', () => ({
      licenseService: { loadFromString: () => ({ valid: true }) }
    }))
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, license: 'LICENSE-TEXT' })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { activateOnline } = await import('../src/main/license/activation-client')
    await activateOnline('CARD-1234', 'fingerprint')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      method: 'POST',
      redirect: 'error'
    })
  })
})
