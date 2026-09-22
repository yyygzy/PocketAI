// License 验签 + 硬盘指纹绑定 + Lite 门控单元测试
//
// 策略：
// - 内置公钥（public-key.ts）mock 为测试时动态生成的 RSA 公钥，私钥仅存在于本测试中；
//   LicenseService.generateLicense 用该私钥签发，loadFromString 走完整真实验签链路。
// - getDiskFingerprint mock 成可控值，用于验证「同盘通过 / 异盘拒绝」。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// 测试密钥对：私钥通过 mock 模块的隐藏导出带回测试（真实 public-key.ts 无此导出）
vi.mock('../src/main/license/public-key', async () => {
  const { generateKeyPairSync } = await import('node:crypto')
  // 直接生成 PEM 字符串，避免 KeyObject.export 跨 vitest 运行时的兼容问题
  const kp = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const der = (kp.publicKey as string).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  return { PUBLIC_KEY_DER_B64: der, __TEST_PRIVATE_KEY_PEM: kp.privateKey }
})

vi.mock('../src/main/steward/hardware', () => ({
  getDiskFingerprint: vi.fn(() => 'aaaabbbbccccdddd')
}))

import {
  LicenseService,
  licenseService,
  LITE_LIMITS,
  assertCanCreateAssistant,
  assertCanCreateKb,
  type LicensePayload
} from '../src/main/license/license'
import * as keyModule from '../src/main/license/public-key'
import { getDiskFingerprint } from '../src/main/steward/hardware'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const privPem = (keyModule as any).__TEST_PRIVATE_KEY_PEM as string
const fpMock = vi.mocked(getDiskFingerprint)

// 另一把私钥（用于「签名公钥不匹配」用例）
const wrongKeypair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
})
const wrongPrivPem = wrongKeypair.privateKey as string

function basePayload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    version: 1,
    license_id: 'LIC-TEST-0001',
    owner: 'tester',
    issued_at: Date.now() - 86_400_000,
    expires_at: Date.now() + 365 * 86_400_000,
    plan: 'pro',
    features: ['agent', 'mcp'],
    disk_fingerprint: '',
    ...over
  }
}

const sign = (p: LicensePayload): string => LicenseService.generateLicense(privPem, p)

describe('License 验签', () => {
  beforeEach(() => {
    fpMock.mockReturnValue('aaaabbbbccccdddd')
  })
  afterEach(() => {
    licenseService.clear()
  })

  it('未绑定设备的有效 license → valid', () => {
    const svc = new LicenseService()
    const st = svc.loadFromString(sign(basePayload()))
    expect(st.valid).toBe(true)
    expect(st.signatureOk).toBe(true)
    expect(st.expired).toBe(false)
    expect(st.error).toBeUndefined()
    expect(st.payload?.owner).toBe('tester')
  })

  it('指纹与当前硬盘一致 → valid（U盘同盘换机场景）', () => {
    fpMock.mockReturnValue('1111222233334444')
    const svc = new LicenseService()
    const st = svc.loadFromString(sign(basePayload({ disk_fingerprint: '1111222233334444' })))
    expect(st.valid).toBe(true)
    expect(st.payload?.disk_fingerprint).toBe('1111222233334444')
  })

  it('指纹与当前硬盘不一致 → invalid，签名仍为真（复制到别的硬盘应拒绝）', () => {
    fpMock.mockReturnValue('eeeeffff00001111')
    const svc = new LicenseService()
    const st = svc.loadFromString(sign(basePayload({ disk_fingerprint: '1111222233334444' })))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(true)
    expect(st.expired).toBe(false)
    expect(st.error).toContain('硬盘')
    expect(st.payload).toBeDefined()
  })

  it('本机无法读取指纹而 license 已绑定 → 拒绝（fail closed）', () => {
    fpMock.mockReturnValue(null)
    const svc = new LicenseService()
    const st = svc.loadFromString(sign(basePayload({ disk_fingerprint: '1111222233334444' })))
    expect(st.valid).toBe(false)
    expect(st.error).toContain('硬盘')
  })

  it('签名后篡改 owner → 签名校验失败', () => {
    const lic = JSON.parse(sign(basePayload())) as LicensePayload & { signature: string }
    lic.owner = 'cracker'
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
    expect(st.error).toContain('签名')
    expect(st.payload).toBeUndefined()
  })

  it('签名后给 features 增项 → 签名校验失败（权限无法自抬）', () => {
    const lic = JSON.parse(sign(basePayload())) as LicensePayload & { signature: string }
    lic.features = [...lic.features, 'encryption']
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('签名后篡改硬盘指纹 → 签名校验失败（无法自行换绑）', () => {
    const lic = JSON.parse(sign(basePayload({ disk_fingerprint: '1111222233334444' }))) as LicensePayload & { signature: string }
    lic.disk_fingerprint = 'aaaa1111bbbb2222'
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('用非配对私钥签名 → 签名校验失败', () => {
    const lic = LicenseService.generateLicense(wrongPrivPem, basePayload())
    const st = new LicenseService().loadFromString(lic)
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('缺少 disk_fingerprint 字段（旧 7 字段 license）→ 直接拒绝', () => {
    const p = basePayload()
    delete (p as Partial<LicensePayload>).disk_fingerprint
    const lic = LicenseService.generateLicense(privPem, p)
    // 旧 license JSON 中根本没有该字段
    expect(lic).not.toContain('disk_fingerprint')
    const st = new LicenseService().loadFromString(lic)
    expect(st.valid).toBe(false)
    expect(st.error).toContain('disk_fingerprint')
  })

  it('已过期 license → invalid 且 expired=true，payload 仍可读', () => {
    const st = new LicenseService().loadFromString(
      sign(basePayload({ issued_at: Date.now() - 200_000, expires_at: Date.now() - 100_000 }))
    )
    expect(st.valid).toBe(false)
    expect(st.expired).toBe(true)
    expect(st.signatureOk).toBe(true)
    expect(st.payload?.license_id).toBe('LIC-TEST-0001')
  })

  it('JSON 损坏 → invalid 且不抛异常', () => {
    const st = new LicenseService().loadFromString('{ this is not json')
    expect(st.valid).toBe(false)
    expect(st.error).toContain('JSON')
  })

  it('features 顺序不影响验签（两侧都排序规范化）', () => {
    const lic = sign(basePayload({ features: ['mcp', 'agent', 'backup'] }))
    const reparsed = JSON.parse(lic) as LicensePayload & { signature: string }
    reparsed.features = ['backup', 'mcp', 'agent'] // 仅 JSON 排列变化，集合不变
    const st = new LicenseService().loadFromString(JSON.stringify(reparsed))
    expect(st.valid).toBe(true)
  })
})

describe('功能门控与 Lite 限制', () => {
  afterEach(() => {
    licenseService.clear()
  })

  it('无 license：hasFeature 恒 false', () => {
    expect(licenseService.hasFeature('mcp')).toBe(false)
  })

  it('无 license：助手达到上限抛错、知识库达到上限抛错', () => {
    expect(() => assertCanCreateAssistant(LITE_LIMITS.assistants - 1)).not.toThrow()
    expect(() => assertCanCreateAssistant(LITE_LIMITS.assistants)).toThrow(/免费版/)
    expect(() => assertCanCreateKb(LITE_LIMITS.knowledgeBases - 1)).not.toThrow()
    expect(() => assertCanCreateKb(LITE_LIMITS.knowledgeBases)).toThrow(/免费版/)
  })

  it('有效 pro license：解除数量限制，仅解锁声明的 features', () => {
    const st = licenseService.loadFromString(sign(basePayload({ plan: 'pro', features: ['mcp'] })))
    expect(st.valid).toBe(true)
    expect(licenseService.hasFeature('mcp')).toBe(true)
    expect(licenseService.hasFeature('not-declared')).toBe(false)
    expect(() => assertCanCreateAssistant(999)).not.toThrow()
    expect(() => assertCanCreateKb(999)).not.toThrow()
  })

  it('enterprise license：全部 features 隐式解锁', () => {
    const st = licenseService.loadFromString(
      sign(basePayload({ plan: 'enterprise', features: [] }))
    )
    expect(st.valid).toBe(true)
    expect(licenseService.hasFeature('any-feature-name')).toBe(true)
  })

  it('过期的 pro license 不解除限制', () => {
    licenseService.loadFromString(
      sign(basePayload({ expires_at: Date.now() - 1000 }))
    )
    expect(licenseService.hasFeature('mcp')).toBe(false)
    expect(() => assertCanCreateAssistant(LITE_LIMITS.assistants)).toThrow()
  })
})
