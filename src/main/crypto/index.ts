// 加密核心模块（M1.1 / L3 字段级加密）
//
// 三层加密职责：
// L1 卷级 → VeraCrypt 便携版 / BitLocker，应用不负责
// L2 库级 → sqlcipher（PRAGMA key），database.ts 预留接口
// L3 字段级 → field-encrypt.ts，AES-256-GCM 加密敏感字段
//
// 主密码派生：scrypt（N=32768, r=8, p=1，约 64MB 内存）→ 32 字节 AES 密钥
//   这是全应用唯一的派生路径（master-key.ts 的 setKey 与固定密钥
//   都走 deriveKeySync）。历史上曾有 Argon2id 方案，因 hash-wasm
//   异步派生无法满足同步初始化而废弃，已移除，勿再引入第二套派生算法。
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
}

/**
 * 从密码/主密钥材料同步派生 AES-256 密钥（全应用唯一派生实现）
 *
 * scrypt 参数取 OWASP 推荐档位：N=2^15（64MB）、r=8、p=1。
 * 同步实现是因为 master-key.init() 在应用启动路径上需要立即拿到密钥；
 * 派生耗时约 50-100ms，主进程启动期可接受。
 *
 * @param password 用户主密码（无密码模式下为固定混淆口令）
 * @param salt 提供则复用（验证/解锁场景），不提供则随机生成（首次设密场景）
 */
export function deriveKeySync(password: string, salt?: Buffer): KeyMaterial {
  const useSalt = salt ?? randomBytes(SALT_LEN)
  const key = scryptSync(password || '', useSalt, AES_KEY_LEN, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024
  })
  return { key, salt: useSalt }
}
