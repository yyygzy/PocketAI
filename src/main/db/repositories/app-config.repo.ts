// app_config 仓储：键值对配置存储
// 用于持久化 encryption_mode / has_master_password 等启动配置
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dbService } from '../database'
import { CONFIG_PATH } from '../../portable'

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
  FIRST_RUN_WIZARD_DONE: 'first_run_wizard_done', // '1'=已完成首启向导
  MACHINE_ID: 'machine_id', // 上次运行的机器指纹（换电脑检测）
} as const

// ---------- 主密码 salt 双通道 ----------
//
// salt 不是秘密（KDF 公开参数），但必须在 DB 未解锁/未打开时可读，
// 否则加密库会陷入「要读 salt 才能派生密钥解锁、要解锁才能读 salt」死锁
// （salt 存在加密库内，boot 解锁在无 key 连接上必失败）。
// 主通道：config.json（明文文件，随库无关）；DB 内保留一份兼容回退。

function readSaltFromConfigFile(): string | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return typeof cfg?.masterPasswordSalt === 'string' ? cfg.masterPasswordSalt : null
  } catch {
    return null
  }
}

function writeSaltToConfigFile(b64: string | null): void {
  try {
    let cfg: Record<string, unknown> = {}
    if (existsSync(CONFIG_PATH)) {
      try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {} } catch { /* 损坏则重建 */ }
    }
    if (b64 === null) delete cfg.masterPasswordSalt
    else cfg.masterPasswordSalt = b64
    // 0600：文件名通用，未来可能承载其他敏感配置；仅对新建文件生效
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch { /* 写失败不阻塞主流程：DB 内仍有备份 */ }
}

// ---------- 恢复密钥包（库外通道） ----------
//
// 与 salt 同理但更严格：恢复包用于「忘记主密码」场景，此时 DB 无法打开，
// 包绝不能存进加密 DB（否则鸡生蛋）。只放 config.json，跟随便携目录走，
// 且已纳入备份文件清单（files-service）。包内是「恢复码派生密钥加密后的
// masterKey」，config.json 被读到也无法离线伪造（暴力破解恢复码）。

function readRecoveryBlobFromConfigFile(): string | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    return typeof cfg?.recoveryBlob === 'string' ? cfg.recoveryBlob : null
  } catch {
    return null
  }
}

function writeRecoveryBlobToConfigFile(blob: string | null): void {
  try {
    let cfg: Record<string, unknown> = {}
    if (existsSync(CONFIG_PATH)) {
      try { cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) ?? {} } catch { /* 损坏则重建 */ }
    }
    if (blob === null) delete cfg.recoveryBlob
    else cfg.recoveryBlob = blob
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600 })
  } catch (e) {
    throw new Error(`恢复密钥写入 config.json 失败: ${(e as Error).message}`)
  }
}

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
    // 主通道：config.json（DB 未打开/未解锁时也可读）
    const fromFile = readSaltFromConfigFile()
    if (fromFile) return Buffer.from(fromFile, 'base64')
    // 回退：DB（旧版本只写了 DB 的数据）；读到即回填 config.json 自愈
    try {
      const b64 = this.get(KEYS.MASTER_PASSWORD_SALT)
      if (!b64) return null
      writeSaltToConfigFile(b64)
      return Buffer.from(b64, 'base64')
    } catch {
      return null // DB 未打开或加密未解锁
    }
  },

  setMasterPasswordSalt(salt: Buffer): void {
    const b64 = salt.toString('base64')
    writeSaltToConfigFile(b64)
    this.set(KEYS.MASTER_PASSWORD_SALT, b64)
  },

  /** 清除 salt（禁用加密时调用）：config.json + DB 双删 */
  clearMasterPasswordSalt(): void {
    writeSaltToConfigFile(null)
    try { this.delete(KEYS.MASTER_PASSWORD_SALT) } catch { /* DB 未开时忽略 */ }
  },

  // ---------- 恢复密钥包 ----------

  getRecoveryBlob(): string | null {
    return readRecoveryBlobFromConfigFile()
  },

  setRecoveryBlob(blob: string): void {
    writeRecoveryBlobToConfigFile(blob)
  },

  clearRecoveryBlob(): void {
    writeRecoveryBlobToConfigFile(null)
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
  },

  // ---------- 首启向导 ----------

  isFirstRunWizardDone(): boolean {
    return this.get(KEYS.FIRST_RUN_WIZARD_DONE) === '1'
  },

  setFirstRunWizardDone(done: boolean): void {
    this.set(KEYS.FIRST_RUN_WIZARD_DONE, done ? '1' : '0')
  },

  getMachineId(): string | null {
    return this.get(KEYS.MACHINE_ID)
  },

  setMachineId(id: string): void {
    this.set(KEYS.MACHINE_ID, id)
  }
}
