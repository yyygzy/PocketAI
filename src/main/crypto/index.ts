// 加密核心模块（M1.1 / L3 字段级加密）
//
// 三层加密职责：
// L1 卷级 → VeraCrypt 便携版 / BitLocker，应用不负责
// L2 库级 → sqlcipher（PRAGMA key），database.ts 预留接口
// L3 字段级 → field-encrypt.ts，AES-256-GCM 加密敏感字段
//
// 主密码派生：scrypt → 32 字节 AES 密钥。**参数是分档的，不是全局常量**：
//   KDF_LEGACY  = N=2^15,r=8,p=1（32MiB，实测约 164ms）——历史所有落盘工件的档位
//   KDF_CURRENT = N=2^17,r=8,p=1（128MiB，实测约 705ms）——新设/改密后的主密码档位
//   档位必须随库落盘（appConfigRepo.getKdfParams），否则旧库派生不匹配=把用户锁在门外。
//   固定混淆密钥、恢复包 rv1:、加密导出 MOXENC1、备份 PKBK1/2 一律**显式钉在 KDF_LEGACY**：
//   它们的格式里都没有参数位，改动等于一次性打爆既有数据（详见台账 SEC-32②）。
//   这是全应用唯一的派生实现（历史上曾有 Argon2id，因异步无法满足同步初始化已移除，
//   勿再引入第二套派生算法）。
// 字段加密格式（见 field-encrypt.ts）：
//   v1:base64(iv:12 + ciphertext + tag:16)
//   密钥由 masterKeyManager 统一持有，密文中不携带 salt
// 备份包加密（见 backup-service.ts encryptBackup）：
//   key = sha256(baseKey ‖ salt)，baseKey 为高熵 32 字节密钥，
//   混入随机 salt 即可，无需慢哈希

import { randomBytes, scryptSync } from 'node:crypto'

const AES_KEY_LEN = 32 // AES-256
const SALT_LEN = 16

export interface KeyMaterial {
  /** 32 字节 AES-256 密钥 */
  key: Buffer
  /** 16 字节 salt（用于重新派生） */
  salt: Buffer
  /** 实际使用的档位（调用方据此落盘标记） */
  params: KdfParams
}

export interface KdfParams {
  N: number
  r: number
  p: number
}

/** 历史档位：所有既有落盘工件（旧库、固定混淆密钥、rv1:、MOXENC1、PKBK1/2）都用它 */
export const KDF_LEGACY: KdfParams = { N: 32768, r: 8, p: 1 }

/** 现行档位：新设主密码与改密后的库使用（4× 暴破成本，解锁约 +0.54s） */
export const KDF_CURRENT: KdfParams = { N: 131072, r: 8, p: 1 }

/**
 * 允许出现的档位白名单。config.json 里的 kdfParams **不能**直接当参数用：
 * 一个被编辑过的 N（或 r/p）会在同步的解锁路径上把主进程内存/时间打爆，
 * 因此只接受这里列出的组合，其余一律回退到 KDF_LEGACY。
 */
export const KNOWN_KDF_TIERS: KdfParams[] = [KDF_LEGACY, KDF_CURRENT]

/** 归一化外部读到的档位；非白名单一律 null（调用方决定回退策略） */
export function normalizeKdfParams(raw: unknown): KdfParams | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const cand: KdfParams = { N: Number(o.N), r: Number(o.r), p: Number(o.p) }
  return KNOWN_KDF_TIERS.find((t) => t.N === cand.N && t.r === cand.r && t.p === cand.p) ?? null
}

/** 展示用短标签（设置页显示当前库的派生档位） */
export function kdfTierLabel(p: KdfParams): string {
  return `scrypt N=2^${Math.log2(p.N)} r=${p.r} p=${p.p}`
}

/**
 * scrypt 实际占用 ≈ 128·N·r·p 字节，但 maxmem **恰等于理论值会抛** memory limit exceeded
 * （OpenSSL 内部还要额外分配），因此这里留 2× 余量：上限只是许可值，不改变派生结果。
 * 去掉这个 ×2 会让现行档（N=2^17）在解锁时当场抛错，tests/kdf-params.test.ts 钉住了这点。
 */
function maxMemFor(p: KdfParams): number {
  return Math.max(64 * 1024 * 1024, 128 * p.N * p.r * p.p * 2)
}

/**
 * 从密码/主密钥材料同步派生 AES-256 密钥（全应用唯一派生实现）
 *
 * 默认档位 = KDF_LEGACY：不显式传参的调用方（固定混淆密钥、恢复包、加密导出、备份）
 * 行为与改动前逐字节一致，不会被升档波及。
 * 同步实现是因为主进程启动与每次解锁都要立即拿到密钥（2^17 实测约 705ms）。
 *
 * @param password 用户主密码（无密码模式下为固定混淆口令）
 * @param salt 提供则复用（验证/解锁场景），不提供则随机生成（首次设密场景）
 * @param params scrypt 档位，默认历史档
 */
export function deriveKeySync(
  password: string,
  salt?: Buffer,
  params: KdfParams = KDF_LEGACY
): KeyMaterial {
  const useSalt = salt ?? randomBytes(SALT_LEN)
  const key = scryptSync(password || '', useSalt, AES_KEY_LEN, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxMemFor(params)
  })
  return { key, salt: useSalt, params }
}
