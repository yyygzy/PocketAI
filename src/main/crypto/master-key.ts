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
//   - 'none'   → 无密码模式，init() 直接派生固定字段密钥并标记已解锁
//   - 'db'     → 显示解锁窗口 → 用户输入密码 → setKey(password, salt)
// - 运行时：锁/解锁可触发 clear() → 重新 deriveKey
// - 退出：进程销毁，密钥自动消失

import { randomBytes } from 'node:crypto'
import type { EncryptionMode } from '../db/database'
import { deriveKeySync } from './index'

// 固定密钥（无密码模式下字段加密用的弱混淆密钥）
// 仅用于非敏感场景（config.json 等），不是真正的安全保障：
// 派生输入（下方口令与盐）随源码公开，任何人可复现。
// 实现上用 deriveKeySync（scrypt）从固定口令 + 固定盐派生，
// 避免源码里出现可直接使用的裸密钥字节；换口令/盐会使
// 已落盘的字段密文与 WebDAV 密码密文全部失效，勿随意改动。
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
   *  @param salt 已有的 salt（从 app-config 的 salt 双通道读，config.json 优先）；不传则新建
   */
  setKey(password: string, salt?: Buffer): Buffer {
    if (!password) {
      // 空密码 = 禁用加密（与 init('none') 一致地恢复固定字段密钥）
      this.masterKey = null
      this.mode = 'none'
      this.fixedFieldKey = deriveKeySync(FIXED_KEY_PASSWORD, FIXED_KEY_SALT).key
      this.unlocked = true
      return Buffer.alloc(32)
    }
    const keyMat = deriveKeySync(password, salt)
    this.masterKey = keyMat.key
    this.unlocked = true
    return this.masterKey
  }

  /** 直接设置密钥（用于密码校验失败后的回滚） */
  setRawKey(key: Buffer): void {
    this.masterKey = key
    this.mode = 'db'
    this.unlocked = true
  }

  /** 清除密钥（隐私锁/加密锁触发）。db 模式下字段加密走 masterKey，随之失效；
   *  none 模式的 fixedFieldKey 是公开可再生的混淆密钥，保留以维持后台功能 */
  clear(): void {
    this.masterKey = null
    this.unlocked = false
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

  /**
   * 获取字段加密密钥（db 模式=主密钥，none 模式=固定混淆密钥）。
   * db 模式锁定期间两者皆空 → 抛错，杜绝「用错误密钥加密落盘」；
   * 此状态下加密/解密调用方都应已被锁网关或调度器挡住。
   */
  getFieldKey(): Buffer {
    if (this.masterKey) return this.masterKey
    if (this.fixedFieldKey) return this.fixedFieldKey
    throw new Error('字段加密密钥不可用：加密模式已锁定')
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
