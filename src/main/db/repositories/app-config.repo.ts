// app_config 仓储：键值对配置存储
// 用于持久化 encryption_mode / has_master_password 等启动配置
import { dbService } from '../database'

export type EncryptionMode = 'none' | 'db'
export type CipherType = 'sqlcipher' // 目前只支持 SQLCipher

export interface AppConfigRow {
  key: string
  value: string | null
  updated_at: number
}

const KEYS = {
  ENCRYPTION_MODE: 'encryption_mode',
  HAS_MASTER_PASSWORD: 'has_master_password',
  MASTER_PASSWORD_SALT: 'master_password_salt', // base64 编码
  CIPHER_TYPE: 'cipher_type',
  AUTO_LOCK_TIMEOUT: 'auto_lock_timeout', // ms，0=永不
  LICENSE_PATH: 'license_path', // 默认 license.lic 的路径
  AUTO_UPDATE_ENABLED: 'auto_update_enabled', // '1'=开启自动更新；缺省=关闭
} as const

export const appConfigRepo = {
  get(key: string): string | null {
    const row = dbService
      .getHandle()
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(key) as { value: string | null } | undefined
    return row?.value ?? null
  },

  set(key: string, value: string): void {
    const now = Date.now()
    dbService
      .getHandle()
      .prepare(
        `INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
      )
      .run(key, value, now)
  },

  delete(key: string): void {
    dbService.getHandle().prepare('DELETE FROM app_config WHERE key = ?').run(key)
  },

  // ---------- 便捷方法 ----------

  getEncryptionMode(): EncryptionMode {
    return (this.get(KEYS.ENCRYPTION_MODE) as EncryptionMode | null) ?? 'none'
  },

  setEncryptionMode(mode: EncryptionMode): void {
    this.set(KEYS.ENCRYPTION_MODE, mode)
  },

  hasMasterPassword(): boolean {
    return this.get(KEYS.HAS_MASTER_PASSWORD) === '1'
  },

  setHasMasterPassword(has: boolean): void {
    this.set(KEYS.HAS_MASTER_PASSWORD, has ? '1' : '0')
  },

  getMasterPasswordSalt(): Buffer | null {
    const b64 = this.get(KEYS.MASTER_PASSWORD_SALT)
    return b64 ? Buffer.from(b64, 'base64') : null
  },

  setMasterPasswordSalt(salt: Buffer): void {
    this.set(KEYS.MASTER_PASSWORD_SALT, salt.toString('base64'))
  },

  getAutoLockTimeout(): number {
    const v = this.get(KEYS.AUTO_LOCK_TIMEOUT)
    return v ? Number(v) : 0
  },

  setAutoLockTimeout(ms: number): void {
    this.set(KEYS.AUTO_LOCK_TIMEOUT, String(ms))
  },

  getLicensePath(): string {
    return this.get(KEYS.LICENSE_PATH) ?? ''
  },

  setLicensePath(p: string): void {
    this.set(KEYS.LICENSE_PATH, p)
  },

  // 自动更新默认关闭：未配置时返回 false
  isAutoUpdateEnabled(): boolean {
    return this.get(KEYS.AUTO_UPDATE_ENABLED) === '1'
  },

  setAutoUpdateEnabled(enabled: boolean): void {
    this.set(KEYS.AUTO_UPDATE_ENABLED, enabled ? '1' : '0')
  }
}
