// SEC-16-15 · License 签名算法版本分流回归
//
// 关键点：
// - 密钥版本（RSA 旧 / Ed25519 新）与 payload.version / updates_until 的「许可证格式版本」无关；
//   分流只看签名字段的 ed25519: 前缀。
// - 所有密钥对都在测试运行时生成，私钥只在内存/系统临时目录，绝不落入仓库或测试夹具。
// - 发行脚本 issue-license.js 走环境变量 / 外部路径读私钥，签出的证由 App 真实验签。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEYS = vi.hoisted(() => ({
  rsaPubDer: '',
  rsaPriv: '',
  edPubDer: '',
  edPriv: '',
  edConfigured: true
}))

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  ipcRenderer: {},
  contextBridge: { exposeInMainWorld: () => {} }
}))

// 公钥模块 mock：两把公钥都来自运行时生成的密钥对；edConfigured 可模拟「轮换尚未完成」。
vi.mock('../src/main/license/public-key', async () => {
  const { generateKeyPairSync: gen } = await import('node:crypto')
  const rsa = gen('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const ed = gen('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  })
  const der = (pem: string) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')
  KEYS.rsaPubDer = der(rsa.publicKey as string)
  KEYS.rsaPriv = rsa.privateKey as string
  KEYS.edPubDer = der(ed.publicKey as string)
  KEYS.edPriv = ed.privateKey as string
  return {
    PUBLIC_KEY_DER_B64: KEYS.rsaPubDer,
    get ED25519_PUBLIC_KEY_B64() { return KEYS.edConfigured ? KEYS.edPubDer : '' }
  }
})

vi.mock('../src/main/steward/hardware', () => ({
  getDiskFingerprint: vi.fn(() => ''),
  getDiskFingerprintAsync: vi.fn(async () => '')
}))

import { LicenseService, ED25519_SIGNATURE_PREFIX, type LicensePayload } from '../src/main/license/license'

const ISSUE = createRequire(import.meta.url)('../scripts/lib/issue-license.js') as {
  issueLicense: (o: Record<string, unknown>) => {
    licenseJson: string
    payload: LicensePayload
    algorithm: string
  }
  canonicalize: (p: LicensePayload) => string
}

function payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return {
    version: 2,
    license_id: 'LIC-ED25519-0001',
    owner: 'sec16-tester',
    issued_at: Date.now() - 1000,
    expires_at: Date.now() + 365 * 86_400_000,
    updates_until: Date.now() + 30 * 86_400_000,
    plan: 'pro',
    features: ['mcp', 'agent'],
    disk_fingerprint: '',
    ...over
  }
}

/** App 侧签名 → 文件 JSON */
const signed = (priv: string, p = payload()) => JSON.parse(LicenseService.generateLicense(priv, p)) as LicensePayload & { signature: string }

let tempDir = ''
const savedEnv = {
  pem: process.env.POCKETAI_LICENSE_PRIVATE_KEY,
  path: process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH
}

afterEach(() => {
  KEYS.edConfigured = true
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = ''
  if (savedEnv.pem === undefined) delete process.env.POCKETAI_LICENSE_PRIVATE_KEY
  else process.env.POCKETAI_LICENSE_PRIVATE_KEY = savedEnv.pem
  if (savedEnv.path === undefined) delete process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH
  else process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH = savedEnv.path
})

describe('SEC-16-15 签名版本分流（与许可证格式版本无关）', () => {
  it('Ed25519 私钥签发 → 带前缀签名，App 验签通过', () => {
    const lic = signed(KEYS.edPriv)
    expect(lic.signature.startsWith(ED25519_SIGNATURE_PREFIX)).toBe(true)
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(true)
    expect(st.signatureOk).toBe(true)
    expect(st.payload?.owner).toBe('sec16-tester')
  })

  it('历史 RSA 私钥签发 → 裸 base64 签名，过渡期仍验签通过', () => {
    const lic = signed(KEYS.rsaPriv, payload({ version: 1, updates_until: undefined }))
    expect(lic.signature.startsWith(ED25519_SIGNATURE_PREFIX)).toBe(false)
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(true)
    expect(st.signatureOk).toBe(true)
  })

  it('v1 / v2 许可证格式都能用 Ed25519 签名通过（两个版本维度互不耦合）', () => {
    const v1 = signed(KEYS.edPriv, payload({ version: 1, updates_until: undefined }))
    const v2 = signed(KEYS.edPriv, payload({ version: 2 }))
    expect(new LicenseService().loadFromString(JSON.stringify(v1)).valid).toBe(true)
    expect(new LicenseService().loadFromString(JSON.stringify(v2)).valid).toBe(true)
  })

  it('Ed25519 签名篡改载荷 → fail closed', () => {
    const lic = signed(KEYS.edPriv)
    lic.owner = 'cracker'
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('签名版本前缀不可互换：剥掉前缀 / 给 RSA 签名加前缀都验签失败', () => {
    const ed = signed(KEYS.edPriv)
    const rsa = signed(KEYS.rsaPriv)
    const stripped = { ...ed, signature: ed.signature.slice(ED25519_SIGNATURE_PREFIX.length) }
    const mislabeled = { ...rsa, signature: ED25519_SIGNATURE_PREFIX + rsa.signature }
    expect(new LicenseService().loadFromString(JSON.stringify(stripped)).valid).toBe(false)
    expect(new LicenseService().loadFromString(JSON.stringify(mislabeled)).valid).toBe(false)
  })

  it('用另一把 Ed25519 私钥签发 → 公钥不匹配，验签失败', () => {
    const wrong = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    })
    const st = new LicenseService().loadFromString(LicenseService.generateLicense(wrong.privateKey as string, payload()))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('运维尚未填入 Ed25519 公钥：新证 fail-closed，旧 RSA 证仍有效', () => {
    KEYS.edConfigured = false
    expect(new LicenseService().loadFromString(LicenseService.generateLicense(KEYS.edPriv, payload())).valid).toBe(false)
    expect(new LicenseService().loadFromString(LicenseService.generateLicense(KEYS.rsaPriv, payload())).valid).toBe(true)
  })
})

describe('SEC-16-15 发行脚本私钥外部化 + Ed25519 签发', () => {
  it('从环境变量 POCKETAI_LICENSE_PRIVATE_KEY 读 Ed25519 私钥 → 新证可被 App 验证', () => {
    process.env.POCKETAI_LICENSE_PRIVATE_KEY = KEYS.edPriv
    delete process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH
    const r = ISSUE.issueLicense({ owner: 'env-tester', plan: 'pro', days: 3650 })
    expect(r.algorithm).toBe('ed25519')
    expect(r.licenseJson).toContain(ED25519_SIGNATURE_PREFIX)
    const st = new LicenseService().loadFromString(r.licenseJson)
    expect(st.valid).toBe(true)
    expect(st.payload?.owner).toBe('env-tester')
  })

  it('从外部路径 POCKETAI_LICENSE_PRIVATE_KEY_PATH 读 Ed25519 私钥 → 新证可被 App 验证', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pocketai-sec15-'))
    const keyPath = join(tempDir, 'runtime-ed25519-key.pem')
    writeFileSync(keyPath, KEYS.edPriv, 'utf8')
    process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH = keyPath
    delete process.env.POCKETAI_LICENSE_PRIVATE_KEY
    const r = ISSUE.issueLicense({ owner: 'path-tester', plan: 'enterprise', days: 3650, updatesDays: 90 })
    expect(r.algorithm).toBe('ed25519')
    expect(new LicenseService().loadFromString(r.licenseJson).valid).toBe(true)
  })

  it('显式 RSA 私钥路径 → 仍签历史裸 base64 证，App 过渡期兼容', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pocketai-sec15-'))
    const keyPath = join(tempDir, 'runtime-rsa-key.pem')
    writeFileSync(keyPath, KEYS.rsaPriv, 'utf8')
    const r = ISSUE.issueLicense({ owner: 'rsa-tester', plan: 'pro', days: 3650, keyPath })
    expect(r.algorithm).toBe('rsa')
    expect(r.licenseJson).not.toContain(ED25519_SIGNATURE_PREFIX)
    expect(new LicenseService().loadFromString(r.licenseJson).valid).toBe(true)
  })

  it('请求算法与私钥类型不符 → 明确报错，不静默签出验不过的证', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'pocketai-sec15-'))
    const keyPath = join(tempDir, 'runtime-ed25519-key.pem')
    writeFileSync(keyPath, KEYS.edPriv, 'utf8')
    expect(() => ISSUE.issueLicense({ owner: 'x', plan: 'pro', days: 1, keyPath, algorithm: 'rsa' })).toThrow(/私钥类型为 ed25519/)
  })
})
