// License 验签 + 硬盘指纹绑定 + Lite 门控单元测试
//
// 策略：
// - 内置公钥（public-key.ts）mock 为测试时动态生成的 RSA 公钥，私钥仅存在于本测试中；
//   LicenseService.generateLicense 用该私钥签发，loadFromString 走完整真实验签链路。
// - getDiskFingerprint mock 成可控值，用于验证「同盘通过 / 异盘拒绝」。
// - §更新期：v2 件带 updates_until 参与签名；历史件缺失时回退 expires_at（不追溯收紧）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import { readUpdatesWatermark } from '../src/main/license/updates-watermark'

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

function v2Payload(over: Partial<LicensePayload> = {}): LicensePayload {
  return basePayload({ version: 2, updates_until: Date.now() + 60 * 86_400_000, ...over })
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

  // §393：长驻会话跨零点——load 时有效、运行时过期 ⇒ getStatus/hasFeature 当场切档
  it('§393 运行时过期：getStatus 回 expired=true + hasFeature 拒绝 + assertCan 抛', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-11-02T23:00:00Z'))
      const st = licenseService.loadFromString(
        sign(basePayload({ expires_at: Date.parse('2026-11-03T00:00:00Z') }))
      )
      expect(st.valid).toBe(true)
      expect(st.expired).toBe(false)
      expect(licenseService.hasFeature('mcp')).toBe(true)

      // 过了一小时＝过了零点
      vi.setSystemTime(new Date('2026-11-03T01:00:00Z'))
      const st2 = licenseService.getStatus()
      expect(st2.valid).toBe(false)
      expect(st2.expired).toBe(true)
      expect(licenseService.hasFeature('mcp')).toBe(false)
      expect(() => assertCanCreateAssistant(LITE_LIMITS.assistants)).toThrow()
    } finally {
      vi.useRealTimers()
    }
  })
})

// §更新期：使用截止 / 更新截止双字段拆分（A 口径：停更不停用）
describe('更新期拆分（停更不停用）', () => {
  beforeEach(() => {
    fpMock.mockReturnValue('aaaabbbbccccdddd')
  })
  afterEach(() => {
    licenseService.clear()
    vi.useRealTimers()
  })

  it('v2 件：updates_until 参与验签并透出到状态', () => {
    const updatesUntil = Date.now() + 30 * 86_400_000
    const st = new LicenseService().loadFromString(sign(v2Payload({ updates_until: updatesUntil })))
    expect(st.valid).toBe(true)
    expect(st.updatesUntil).toBe(updatesUntil)
    expect(st.updatesExpired).toBe(false)
  })

  it('篡改 updates_until → 签名校验失败（无法自行延长更新期）', () => {
    const lic = JSON.parse(sign(v2Payload())) as LicensePayload & { signature: string }
    lic.updates_until = Date.now() + 10 * 365 * 86_400_000
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('从 v2 件删除 updates_until → 签名校验失败（不能静默回退成按使用截止更新）', () => {
    const lic = JSON.parse(sign(v2Payload())) as LicensePayload & { signature: string }
    delete lic.updates_until
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.signatureOk).toBe(false)
  })

  it('历史件缺失 updates_until → 回退 expires_at（老用户升级后行为不变）', () => {
    const st = new LicenseService().loadFromString(sign(basePayload()))
    expect(st.valid).toBe(true)
    expect(st.payload?.updates_until).toBeUndefined()
    expect(st.updatesUntil).toBe(st.payload?.expires_at)
    expect(st.updatesExpired).toBe(false)
  })

  it('更新期已过但使用期有效 → 仍 valid 且继续解除数量限制（只停更）', () => {
    licenseService.loadFromString(
      sign(v2Payload({ expires_at: Date.now() + 300 * 86_400_000, updates_until: Date.now() - 1000 }))
    )
    const st = licenseService.getStatus()
    expect(st.valid).toBe(true)
    expect(st.updatesExpired).toBe(true)
    expect(licenseService.hasFeature('mcp')).toBe(true)
    expect(() => assertCanCreateAssistant(999)).not.toThrow()
    expect(() => assertCanCreateKb(999)).not.toThrow()
  })

  it('无许可证 → updatesExpired=false（免费版照常获取更新）', () => {
    const st = new LicenseService().getStatus()
    expect(st.valid).toBe(false)
    expect(st.updatesExpired).toBe(false)
    expect(st.updatesUntil).toBeUndefined()
  })

  it('运行时跨过更新截止 → updatesExpired 当场翻转，授权仍然有效', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T23:00:00Z'))
    const svc = new LicenseService()
    svc.loadFromString(
      sign(v2Payload({
        expires_at: Date.parse('2027-11-02T00:00:00Z'),
        updates_until: Date.parse('2026-11-03T00:00:00Z')
      }))
    )
    expect(svc.getStatus().updatesExpired).toBe(false)
    vi.setSystemTime(new Date('2026-11-03T01:00:00Z'))
    const st = svc.getStatus()
    expect(st.valid).toBe(true)
    expect(st.expired).toBe(false)
    expect(st.updatesExpired).toBe(true)
  })

  it('重启语义：已过期许可证再次 getStatus 仍带 payload 且 expired=true（不再显示为未激活）', () => {
    const svc = new LicenseService()
    svc.loadFromString(sign(basePayload({ expires_at: Date.now() - 1000 })))
    const st = svc.getStatus()
    expect(st.valid).toBe(false)
    expect(st.expired).toBe(true)
    expect(st.payload?.license_id).toBe('LIC-TEST-0001')
    expect(st.updatesExpired).toBe(true)
    // 再查一次仍保持（不因首次查询丢失展示信息）
    expect(svc.getStatus().payload).toBeDefined()
    expect(svc.hasFeature('mcp')).toBe(false)
  })

  it('updates_until 类型非法 → 拒绝且提示字段无效', () => {
    const lic = JSON.parse(sign(v2Payload())) as Record<string, unknown> & { signature: string }
    lic.updates_until = 'forever'
    const st = new LicenseService().loadFromString(JSON.stringify(lic))
    expect(st.valid).toBe(false)
    expect(st.error).toContain('updates_until')
  })
})

// §更新期高水位：本机记录曾经获得过的最晚更新期，清除许可证/文件丢失/重装后仍受限
describe('更新期高水位（本机记录）', () => {
  let dir = ''
  let wmPath = ''
  const day = 86_400_000
  const future = (days: number) => Date.now() + days * day

  beforeEach(() => {
    fpMock.mockReturnValue('aaaabbbbccccdddd')
    dir = mkdtempSync(join(tmpdir(), 'pocketai-wm-'))
    wmPath = join(dir, 'license-updates.json')
  })
  afterEach(() => {
    licenseService.clear()
    vi.useRealTimers()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('老用户升级：加载有效许可证时用其更新期初始化水位', () => {
    const svc = new LicenseService(wmPath)
    const until = future(30)
    svc.loadFromString(sign(v2Payload({ expires_at: future(365), updates_until: until })))
    expect(readUpdatesWatermark(wmPath)).toBe(until)
  })

  it('历史 v1 件：按运行时兜底的使用截止初始化水位', () => {
    const svc = new LicenseService(wmPath)
    const exp = future(365)
    svc.loadFromString(sign(basePayload({ expires_at: exp })))
    expect(readUpdatesWatermark(wmPath)).toBe(exp)
  })

  it('清除许可证后仍受限：更新期已过则继续拦更新，且许可证本身不再有效', () => {
    const svc = new LicenseService(wmPath)
    const ended = Date.now() - 1000 // 使用期还有效，但更新期已过
    svc.loadFromString(sign(v2Payload({ expires_at: future(365), updates_until: ended })))
    expect(svc.getStatus().updatesExpired).toBe(true)

    svc.clear()
    const st = svc.getStatus()
    expect(st.valid).toBe(false)
    expect(st.payload).toBeUndefined()
    expect(st.updatesUntil).toBe(ended)
    expect(st.updatesExpired).toBe(true)
    // 清除许可证不清理本机记录
    expect(readUpdatesWatermark(wmPath)).toBe(ended)
  })

  it('重装/无许可证文件：新实例只凭本机水位仍受限', () => {
    const ended = Date.now() - 1000
    new LicenseService(wmPath).loadFromString(
      sign(v2Payload({ expires_at: future(365), updates_until: ended }))
    )

    // 模拟重启/重装后只有数据目录、没有 license.lic
    const restarted = new LicenseService(wmPath)
    const st = restarted.getStatus()
    expect(st.valid).toBe(false)
    expect(st.updatesUntil).toBe(ended)
    expect(st.updatesExpired).toBe(true)
  })

  it('未来的水位同样保留：重启后即使没有许可证也不回到免费更新态', () => {
    const until = future(90)
    new LicenseService(wmPath).loadFromString(
      sign(v2Payload({ expires_at: future(365), updates_until: until }))
    )

    const st = new LicenseService(wmPath).getStatus()
    expect(st.valid).toBe(false)
    expect(st.updatesUntil).toBe(until)
    expect(st.updatesExpired).toBe(false)
  })

  it('许可证更新期更晚 → 抬高；换成更早的许可证 → 不回落', () => {
    const svc = new LicenseService(wmPath)
    const early = future(10)
    const late = future(90)

    svc.loadFromString(sign(v2Payload({ expires_at: future(365), updates_until: early })))
    expect(svc.getStatus().updatesUntil).toBe(early)

    svc.loadFromString(sign(v2Payload({ expires_at: future(365), updates_until: late })))
    expect(svc.getStatus().updatesUntil).toBe(late)
    expect(readUpdatesWatermark(wmPath)).toBe(late)

    svc.loadFromString(sign(v2Payload({ expires_at: future(365), updates_until: early })))
    expect(svc.getStatus().updatesUntil).toBe(late)
    expect(readUpdatesWatermark(wmPath)).toBe(late)
  })

  it('设备绑定不匹配的许可证不抬高本机水位（别台机器的更新期不算数）', () => {
    fpMock.mockReturnValue('eeeeffff00001111')
    const svc = new LicenseService(wmPath)
    svc.loadFromString(
      sign(v2Payload({
        disk_fingerprint: '1111222233334444',
        expires_at: future(365),
        updates_until: future(90)
      }))
    )
    expect(svc.getStatus().valid).toBe(false)
    expect(existsSync(wmPath)).toBe(false)
    // 换一个新实例（无许可证）验证：本机水位确实没被别台机器的许可证抬高
    expect(new LicenseService(wmPath).getStatus().updatesUntil).toBeUndefined()
  })

  it('无许可证的免费用户：不写记录、不改变免费更新行为', () => {
    const svc = new LicenseService(wmPath)
    const st = svc.getStatus()
    expect(st.updatesUntil).toBeUndefined()
    expect(st.updatesExpired).toBe(false)
    expect(existsSync(wmPath)).toBe(false)
  })

  it('坏值容错：类型错误 / 负数 / 超大值 / Infinity / JSON 损坏都不永久放行或永久卡住', () => {
    const until = future(30)
    const badContents = [
      '{"updates_until":"forever"}',
      '{"updates_until":-1}',
      '{"updates_until":9000000000000000}', // 约公元 287396 年
      '{"updates_until":1e999}', // JSON.parse → Infinity
      '{ this is not json'
    ]
    for (const content of badContents) {
      writeFileSync(wmPath, content, 'utf8')
      expect(readUpdatesWatermark(wmPath)).toBeNull()

      const svc = new LicenseService(wmPath)
      svc.loadFromString(sign(v2Payload({ expires_at: future(365), updates_until: until })))
      // 坏记录被忽略并按许可证值重写，不会永久拦住更新
      expect(svc.getStatus().updatesUntil).toBe(until)
      expect(readUpdatesWatermark(wmPath)).toBe(until)
    }
  })

  it('时钟回拨：水位是绝对时间戳，回拨不改小、前进按真实时间生效', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T00:00:00Z'))
    const until = Date.parse('2027-01-01T00:00:00Z')
    const svc = new LicenseService(wmPath)
    svc.loadFromString(
      sign(v2Payload({
        expires_at: Date.parse('2028-01-01T00:00:00Z'),
        updates_until: until
      }))
    )
    expect(svc.getStatus().updatesExpired).toBe(false)

    // 回拨到许可证签发之前：水位与判定都按绝对时间走，不被本地时钟改写
    vi.setSystemTime(new Date('2025-01-01T00:00:00Z'))
    expect(readUpdatesWatermark(wmPath)).toBe(until)
    expect(svc.getStatus().updatesUntil).toBe(until)
    expect(svc.getStatus().updatesExpired).toBe(false)

    // 时钟前进到更新截止之后：正常翻转为已结束
    vi.setSystemTime(new Date('2027-02-01T00:00:00Z'))
    expect(svc.getStatus().updatesExpired).toBe(true)
  })
})

// 发行侧脚本与 App 侧规范化必须一致：脚本签出的 v2 件要能被 App 验签
describe('签发脚本与 App 验签一致', () => {
  const requireScript = createRequire(import.meta.url)
  const ISSUE = requireScript('../scripts/lib/issue-license.js') as {
    issueLicense: (o: Record<string, unknown>) => {
      licenseJson: string
      updatesUntil: number | undefined
      expiresAt: number
      payload: LicensePayload
    }
  }

  let dir = ''
  let keyPath = ''
  beforeEach(() => {
    fpMock.mockReturnValue('aaaabbbbccccdddd')
    dir = mkdtempSync(join(tmpdir(), 'pocketai-lic-'))
    keyPath = join(dir, 'key.pem')
    writeFileSync(keyPath, privPem, 'utf8')
  })
  afterEach(() => {
    licenseService.clear()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('默认签发 v1：不写 updates_until，App 验签通过且更新期回退使用截止', () => {
    const r = ISSUE.issueLicense({ owner: 'script-tester', plan: 'pro', days: 3650, keyPath })
    const st = new LicenseService().loadFromString(r.licenseJson)
    expect(st.valid).toBe(true)
    expect(st.payload?.version).toBe(1)
    expect(st.payload?.updates_until).toBeUndefined()
    expect(r.updatesUntil).toBeUndefined()
    expect(st.updatesUntil).toBe(st.payload?.expires_at)
    expect(st.updatesExpired).toBe(false)
  })

  it('显式 updatesDays → 签 v2，更新截止与返回值一致', () => {
    const r = ISSUE.issueLicense({ owner: 'script-tester', plan: 'pro', days: 3650, updatesDays: 30, keyPath })
    const st = new LicenseService().loadFromString(r.licenseJson)
    expect(st.valid).toBe(true)
    expect(st.payload?.version).toBe(2)
    expect(st.payload?.updates_until).toBe(r.updatesUntil)
    expect(st.updatesUntil).toBe(r.updatesUntil)
    expect(st.updatesExpired).toBe(false)
  })

  it('显式 updatesUntil → 签 v2 并采用给定截止', () => {
    const until = Date.now() + 45 * 86_400_000
    const r = ISSUE.issueLicense({ owner: 'script-tester', plan: 'pro', days: 3650, updatesUntil: until, keyPath })
    expect(r.payload.version).toBe(2)
    expect(r.updatesUntil).toBe(until)
    expect(new LicenseService().loadFromString(r.licenseJson).updatesUntil).toBe(until)
  })

  it('显式更新期不超过使用截止（30 天件）', () => {
    const r = ISSUE.issueLicense({ owner: 'short', plan: 'pro', days: 30, updatesDays: 365, keyPath })
    expect(r.updatesUntil).toBe(r.expiresAt)

    const perpetual = ISSUE.issueLicense({ owner: 'forever', plan: 'pro', updatesDays: 365, keyPath })
    const year = 365 * 86_400_000
    expect(perpetual.expiresAt).toBeGreaterThan(Date.parse('2099-01-01T00:00:00Z'))
    expect(perpetual.updatesUntil).toBeGreaterThan(Date.now() + year - 86_400_000)
    expect(perpetual.updatesUntil).toBeLessThan(Date.now() + year + 86_400_000)
  })
})
