// MasterKeyManager：主进程内存中的密钥管理器
//
// 职责：
// 1. 持有从用户主密码派生的 AES-256 密钥（进程内存中，不持久化）
// 2. 为 DB 级加密提供 masterKey（Buffer）
// 3. 为字段级加密提供 per-field 派生密钥
// 4. 提供 hasKey() / setKey() / clear() 状态查询
//
// 生命周期：
// - 启动时：app_config.encryption_mode 决定是否需要密码
//   - 'none'   → 无密码模式，setKey(null) 标记无密钥（字段加密走固定密钥）
//   - 'db'     → 显示解锁窗口 → 用户输入 → deriveKey → setKey(buffer)
// - 运行时：锁/解锁可触发 clear() → 重新 deriveKey
// - 退出：进程销毁，密钥自动消失

import { randomBytes } from 'node:crypto'
import type { EncryptionMode } from '../db/database'
import { deriveKeySync } from './index'

// 固定密钥（无密码模式下字段加密用的弱混淆密钥）
// 仅用于非敏感场景（config.json 等），不是真正的安全保障
// 用 Argon2id 从应用名 + 固定盐派生，避免硬编码裸密钥
const FIXED_KEY_PASSWORD = 'PocketAI-local-only'
const FIXED_KEY_SALT = Buffer.from('PocketAI-fixed-key-v1', 'utf8')

class MasterKeyManager {
  /** DB 级加密用的 master key（32 字节 Buffer），null = 无密码模式 */
  private masterKey: Buffer | null = null

  /** 无密码模式下字段加密用的固定密钥（只用于 apiKeys 等需要保护但没有主密码的场景） */
  private fixedFieldKey: Buffer | null = null

  /** 当前加密模式 */
  private mode: EncryptionMode = 'none'

  /** 是否已经解锁 */
  private unlocked = false

  /** 应用启动时调用，读取配置 */
  init(mode: EncryptionMode): void {
    this.mode = mode
    // 无密码模式：设置固定密钥，直接解锁
    if (mode === 'none') {
      this.fixedFieldKey = deriveKeySync(FIXED_KEY_PASSWORD, FIXED_KEY_SALT).key
      this.unlocked = true
    }
    // 'db' 模式：等待解锁窗口传入密码后调用 setKey()
  }

  /**
   * 设置主密码派生的密钥
   *  @param password 用户输入的主密码（空字符串 = 禁用加密）
   *  @param salt 已有的 salt（DB 加密迁移后从 field_keys 表读）；不传则新建
   */
  setKey(password: string, salt?: Buffer): Buffer {
    if (!password) {
      // 空密码 = 禁用加密
      this.masterKey = null
      this.mode = 'none'
      this.unlocked = true
      return Buffer.alloc(32)
    }
    const keyMat = deriveKeySync(password, salt)
    this.masterKey = keyMat.key
    this.fixedFieldKey = keyMat.key // 字段加密也用同一个主密钥派生
    this.unlocked = true
    return this.masterKey
  }

  /** 清除密钥（隐私锁触发） */
  clear(): void {
    this.masterKey = null
    this.unlocked = false
    // 保留 fixedFieldKey 用于字段加解密（解锁后会重新 setKey）
  }

  /** 是否已解锁 */
  hasKey(): boolean {
    return this.unlocked
  }

  /** 是否启用了 DB 级加密 */
  isDbEncrypted(): boolean {
    return this.mode === 'db' && this.masterKey !== null
  }

  /** 获取 DB 级加密 master key（传给 dbService.open()） */
  getDbKey(): Buffer | null {
    return this.masterKey
  }

  /** 获取字段加密密钥（主密钥或固定密钥） */
  getFieldKey(): Buffer {
    if (this.masterKey) return this.masterKey
    if (this.fixedFieldKey) return this.fixedFieldKey
    // 兜底：派生一次
    const mat = deriveKeySync(FIXED_KEY_PASSWORD, FIXED_KEY_SALT)
    this.fixedFieldKey = mat.key
    return mat.key
  }

  /** 当前加密模式 */
  getMode(): EncryptionMode {
    return this.mode
  }

  /** 生成新 salt（设置主密码时调用） */
  generateSalt(): Buffer {
    return randomBytes(16)
  }
}

export const masterKeyManager = new MasterKeyManager()
