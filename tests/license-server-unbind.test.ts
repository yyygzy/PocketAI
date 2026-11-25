// 管理员解绑通道回归：服务端纯函数 + HTTP 处理核心
// 不启动真实 HTTP 服务、不碰真实台账文件；x-admin-token 与 LICENSE_ADMIN_TOKEN 的比较走 sha256 + timingSafeEqual。
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'

const requireScript = createRequire(import.meta.url)
type ReqHeaders = Record<string, string | undefined>

const SERVER = requireScript('../license-server/server.js') as {
  CODE_RE: RegExp
  unbindCode: (data: Record<string, unknown>, code: string) => {
    ok: boolean
    error?: string
    code?: string
    data?: Record<string, unknown>
    changed?: boolean
  }
  handleAdminUnbind: (
    req: { headers: ReqHeaders },
    ip: string,
    deps: Record<string, unknown>
  ) => Promise<{ status: number; body: Record<string, unknown> }>
  isAdminToken: (req: { headers: ReqHeaders }, configured: string) => boolean
  maskCode: (code: string) => string
}

const CODE = 'PA-2345-6CDE-FGHJ'
const OTHER = 'PA-2345-6CDE-FGHK'
const FP = 'aaaabbbbccccdddd'

function ledger(rec: Record<string, unknown> = {}) {
  return {
    codes: {
      [CODE]: {
        status: 'bound',
        owner: '张三',
        plan: 'pro',
        days: 365,
        updates_days: 30,
        created_at: 1700000000000,
        fingerprint: FP,
        bound_at: 1700000001000,
        license_id: 'lic-1',
        license_json: '{"payload":"bound"}',
        ...rec
      }
    }
  }
}

describe('unbindCode 纯函数', () => {
  it('卡密格式非法 / 不存在 → 明确错误码', () => {
    expect(SERVER.unbindCode(ledger(), 'bad')).toEqual({ ok: false, error: 'CODE_FORMAT_INVALID' })
    expect(SERVER.unbindCode(ledger(), OTHER)).toEqual({ ok: false, error: 'CODE_NOT_FOUND' })
  })

  it('未绑定卡密幂等：changed=false，不复制台账', () => {
    const data = { codes: { [CODE]: { status: 'unused', owner: '李四' } } }
    const r = SERVER.unbindCode(data, CODE)
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(false)
    expect(r.data).toBe(data)
  })

  it('已绑定卡密：清四个绑定字段、状态回 unused，保留签发元数据', () => {
    const data = ledger()
    const r = SERVER.unbindCode(data, CODE)
    expect(r.ok).toBe(true)
    expect(r.changed).toBe(true)
    const codes = r.data?.codes as Record<string, unknown> | undefined
    const rec = codes?.[CODE] as Record<string, unknown>
    expect(rec.status).toBe('unused')
    expect(rec.fingerprint).toBeUndefined()
    expect(rec.bound_at).toBeUndefined()
    expect(rec.license_id).toBeUndefined()
    expect(rec.license_json).toBeUndefined()
    expect(rec.owner).toBe('张三')
    expect(rec.plan).toBe('pro')
    expect(rec.days).toBe(365)
    expect(rec.updates_days).toBe(30)
    expect(rec.created_at).toBe(1700000000000)
    // 纯函数：原台账未被修改
    expect((data.codes[CODE] as Record<string, unknown>).status).toBe('bound')
  })
})

describe('handleAdminUnbind HTTP 核心', () => {
  function deps(overrides: Record<string, unknown> = {}) {
    const saveData = vi.fn(async () => {})
    return {
      adminToken: 'admin-secret',
      skipAuth: false,
      rateLimit: () => true,
      readBody: async () => JSON.stringify({ code: CODE }),
      loadData: () => ledger(),
      saveData,
      ...overrides
    }
  }

  const reqFor = (token: string | undefined): { headers: ReqHeaders } => ({
    headers: token ? { 'x-admin-token': token } : {}
  })

  it('token 未配置 → 503 ADMIN_DISABLED（默认关闭）', async () => {
    const r = await SERVER.handleAdminUnbind(reqFor('admin-secret'), '127.0.0.1', deps({ adminToken: '' }))
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('ADMIN_DISABLED')
  })

  it('token 错误 / 缺失 → 401，不落盘', async () => {
    const d = deps()
    for (const token of [undefined, 'wrong']) {
      const r = await SERVER.handleAdminUnbind(reqFor(token), '127.0.0.1', d)
      expect(r.status).toBe(401)
      expect(r.body.code).toBe('UNAUTHORIZED')
    }
    expect(d.saveData).not.toHaveBeenCalled()
  })

  it('正确 token + 已绑定 → 200，解绑后落盘且响应掩码卡密', async () => {
    const d = deps()
    const r = await SERVER.handleAdminUnbind(reqFor('admin-secret'), '127.0.0.1', d)
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, code: SERVER.maskCode(CODE), changed: true })
    expect(d.saveData).toHaveBeenCalledTimes(1)
    const saved = (d.saveData.mock.calls as unknown as Array<[Record<string, unknown>]>)[0]?.[0]
    expect(saved).toBeDefined()
    const savedCodes = saved?.codes as Record<string, unknown> | undefined
    expect((savedCodes?.[CODE] as Record<string, unknown>).status).toBe('unused')
  })

  it('未绑定 → 200 changed=false，不落盘', async () => {
    const d = deps({
      loadData: () => ({ codes: { [CODE]: { status: 'unused', owner: '李四' } } })
    })
    const r = await SERVER.handleAdminUnbind(reqFor('admin-secret'), '127.0.0.1', d)
    expect(r.status).toBe(200)
    expect(r.body.changed).toBe(false)
    expect(d.saveData).not.toHaveBeenCalled()
  })

  it('请求格式 / 卡密错误 / 不存在 / 超限分别返回稳定错误码', async () => {
    const cases: Array<[string, Record<string, unknown>, number, string]> = [
      ['bad-json', { readBody: async () => '{' }, 400, 'BAD_REQUEST'],
      ['body-too-large', { readBody: async () => { throw new Error('too large') } }, 413, 'BAD_REQUEST'],
      ['bad-code', { readBody: async () => JSON.stringify({ code: 'bad' }) }, 400, 'CODE_FORMAT_INVALID'],
      ['not-found', { readBody: async () => JSON.stringify({ code: OTHER }) }, 404, 'CODE_NOT_FOUND']
    ]
    for (const [, over, status, code] of cases) {
      const r = await SERVER.handleAdminUnbind(reqFor('admin-secret'), '127.0.0.1', deps(over))
      expect(r.status).toBe(status)
      expect(r.body.code).toBe(code)
    }
  })

  it('IP 限速命中 → 429，不读 body 不落盘', async () => {
    const d = deps({ rateLimit: () => false })
    const r = await SERVER.handleAdminUnbind(reqFor('admin-secret'), '127.0.0.1', d)
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('RATE_LIMITED')
    expect(d.saveData).not.toHaveBeenCalled()
  })

  it('token 比较是定长摘要，不受长度差异影响', () => {
    expect(SERVER.isAdminToken(reqFor('admin-secret'), 'admin-secret')).toBe(true)
    expect(SERVER.isAdminToken(reqFor('admin-secret'), 'admin-secret-longer')).toBe(false)
    expect(SERVER.isAdminToken(reqFor(''), 'admin-secret')).toBe(false)
  })
})
