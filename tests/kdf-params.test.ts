// SEC-32②：scrypt 档位版本化
//
// 这份测试承担的是「不锁死老用户」这条底线，所以核心是**逐字节比对**：
// 1. 不传档位时的派生结果必须与改动前（写死 N=2^15, maxmem=128MiB）完全一致
//    —— 固定混淆密钥、恢复包 rv1:、加密导出 MOXENC1、备份 PKBK1/2 全指望这一点。
// 2. 档位白名单必须挡住被编辑过的 config.json：陌生 N 一律回退历史档，
//    否则一个明文文件里写个大 N 就能在同步解锁路径上打爆主进程。
import { describe, it, expect } from 'vitest'
import { scryptSync } from 'node:crypto'
import {
  deriveKeySync,
  normalizeKdfParams,
  kdfTierLabel,
  KDF_LEGACY,
  KDF_CURRENT,
  KNOWN_KDF_TIERS
} from '../src/main/crypto/index'

const SALT = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
const PW = 'correct horse battery staple'

/** 改动前那份实现的等价写法（参数写死），用于钉住「默认行为没变」 */
function legacyAsShipped(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
}

describe('deriveKeySync 默认档位 = 历史档（既有工件兼容性底线）', () => {
  it('默认与显式 KDF_LEGACY 都与「改动前写死的参数」逐字节相同', () => {
    const byDefault = deriveKeySync(PW, SALT)
    const byExplicit = deriveKeySync(PW, SALT, KDF_LEGACY)
    const shipped = legacyAsShipped(PW, SALT)
    expect(byDefault.key.equals(shipped)).toBe(true)
    expect(byExplicit.key.equals(shipped)).toBe(true)
    // 钉死具体十六进制，防止「两个实现一起改错」
    expect(shipped.toString('hex')).toBe(
      'ecf058348a9bfd4febce50a1ae9205da2720790fccdae3644bf0ed98c9740302'
    )
  })

  it('salt 不传时随机生成，传入时原样复用（验证路径必须复用）', () => {
    expect(deriveKeySync(PW, SALT).salt.equals(SALT)).toBe(true)
    const fresh = deriveKeySync(PW)
    expect(fresh.salt.length).toBe(16)
    expect(fresh.salt.equals(SALT)).toBe(false)
  })

  it('返回值把实际用的档位带出来，调用方据此落盘', () => {
    expect(deriveKeySync(PW, SALT).params).toEqual(KDF_LEGACY)
    expect(deriveKeySync(PW, SALT, KDF_CURRENT).params).toEqual(KDF_CURRENT)
  })
})

describe('KDF_CURRENT 档位', () => {
  it('与历史档产出不同密钥（确实升了档，不是换个名字）', () => {
    const a = deriveKeySync(PW, SALT, KDF_LEGACY).key
    const b = deriveKeySync(PW, SALT, KDF_CURRENT).key
    expect(a.equals(b)).toBe(false)
    expect(b.toString('hex')).toBe(
      '383c0968df8f334694cccb4bbe115d0f1d4df21157c63ab9d7a040ffcaaab7c6'
    )
  })

  it('内存上限必须留余量：实测 maxmem 恰等于理论值 128·N·r·p 会直接抛', () => {
    // 这条不是凑数：OpenSSL 在理论值相等的 maxmem 下报 memory limit exceeded，
    // 所以实现里取 2×（N=2^17 → 256MiB 上限，实际占用 128MiB）。
    // 若有人把那个 ×2「优化」掉，现行档解锁会当场抛错，本用例先红。
    const theoretical = 128 * KDF_CURRENT.N * KDF_CURRENT.r * KDF_CURRENT.p
    expect(() =>
      scryptSync(PW, SALT, 32, { N: KDF_CURRENT.N, r: KDF_CURRENT.r, p: KDF_CURRENT.p, maxmem: theoretical })
    ).toThrow(/memory limit exceeded/)
    // 实现的档位必须能吃下同一参数
    expect(() => deriveKeySync(PW, SALT, KDF_CURRENT)).not.toThrow()
  })
})

describe('档位白名单与归一化（config.json 是不可信输入）', () => {
  it('白名单内的档位原样接受', () => {
    for (const t of KNOWN_KDF_TIERS) {
      expect(normalizeKdfParams({ ...t })).toEqual(t)
    }
  })

  it('陌生 N / 缺字段 / 非对象 / 字符串数字一律拒绝', () => {
    expect(normalizeKdfParams({ N: 2 ** 22, r: 8, p: 1 })).toBeNull()
    expect(normalizeKdfParams({ N: 32768, r: 14, p: 1 })).toBeNull()
    expect(normalizeKdfParams({ N: 32768, r: 8 })).toBeNull()
    expect(normalizeKdfParams(null)).toBeNull()
    expect(normalizeKdfParams('32768')).toBeNull()
    expect(normalizeKdfParams(32768)).toBeNull()
    expect(normalizeKdfParams({ N: '32768', r: 8, p: 1 })).toEqual(KDF_LEGACY)
  })

  it('档位标签可读且不含密钥材料', () => {
    expect(kdfTierLabel(KDF_LEGACY)).toBe('scrypt N=2^15 r=8 p=1')
    expect(kdfTierLabel(KDF_CURRENT)).toBe('scrypt N=2^17 r=8 p=1')
  })
})

// none 模式的全部凭据都落在这把派生结果上：它一旦被「顺手升档」，
// 所有既有 v1: 密文立刻变成解不开（表现为 Key 凭空丢失）。
// 这里用独立算出的字节钉死它，而不是拿实现自证。
describe('none 模式固定混淆密钥不随档位功能变化', () => {
  it('init("none") 得到的字段密钥逐字节等于改动前的结果', async () => {
    const expected = scryptSync('PocketAI-local-only', Buffer.from('PocketAI-fixed-key-v1', 'utf8'), 32, {
      N: 32768,
      r: 8,
      p: 1,
      maxmem: 128 * 1024 * 1024
    })
    const { masterKeyManager } = await import('../src/main/crypto/master-key')
    masterKeyManager.init('none')
    expect(masterKeyManager.getFieldKey().equals(expected)).toBe(true)
    // setKey('') （禁用加密 / 恢复到无密码模式）走同一把
    masterKeyManager.setKey('')
    expect(masterKeyManager.getFieldKey().equals(expected)).toBe(true)
  })
})
