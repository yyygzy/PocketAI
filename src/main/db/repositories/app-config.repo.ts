// app_config 仓储：键值对配置存储
// 用于持久化 encryption_mode / has_master_password 等启动配置
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dbService } from '../database'
import { CONFIG_PATH } from '../../portable'
import { errMsg } from '../../error'
import { createLogger } from '../../logger'
import { KDF_LEGACY, normalizeKdfParams, type KdfParams } from '../../crypto/index'

const log = createLogger('config')

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
  MASTER_KDF: 'master_kdf', // scrypt 档位 JSON（SEC-32②；主通道在 config.json，此处为回退副本）
  CIPHER_TYPE: 'cipher_type',
  AUTO_LOCK_TIMEOUT: 'auto_lock_timeout', // ms，0=永不
  LICENSE_PATH: 'license_path', // 默认 license.lic 的路径
  AUTO_UPDATE_ENABLED: 'auto_update_enabled', // '1'=开启自动更新；缺省=关闭
  FIRST_RUN_WIZARD_DONE: 'first_run_wizard_done', // '1'=已完成首启向导
  MACHINE_ID: 'machine_id', // 上次运行的机器指纹（换电脑检测）
  LAUNCH_AT_LOGIN: 'launch_at_login', // '1'=开机自启（仅打包版生效）；缺省=关
  CLOSE_TO_TRAY: 'close_to_tray', // '1'=关窗最小化到托盘而非退出；缺省=关
  USAGE_BUDGET_DAILY: 'usage_budget_daily', // 数字字符串（¥）；空/缺省=不限制
  USAGE_BUDGET_MONTHLY: 'usage_budget_monthly', // 同上
  USAGE_BUDGET_HARD_BLOCK: 'usage_budget_hard_block', // '1'=达到上限自动停发；空/缺省=仅提醒
  USAGE_BUDGET_WARN: 'usage_budget_warn', // '0'=关闭 80% 软预警；'1'/缺省=开启（每周期 toast 一次）
  USAGE_BUDGET_WARNED_DAILY_PREFIX: 'usage_budget_warned_daily_', // +YYYY-MM-DD：今日已弹软预警标记
  USAGE_BUDGET_WARNED_MONTHLY_PREFIX: 'usage_budget_warned_monthly_', // +YYYY-MM：本月已弹标记
  NET_PROXY_URL: 'net_proxy_url', // 主进程 API 流量代理 URL（http/https）；空/缺省=直连
} as const

// 主密码 salt 双通道与 config.json 的读写通道
//
// config.json 里同时住着三把解锁用的钥匙：masterPasswordSalt、kdfParams、recoveryBlob。
// 前两件在 app_config 里各有一份回退副本；**recoveryBlob 只有这一份**（恢复包按设计不能
// 存进加密库，否则「要读包才能解锁、要解锁才能读包」死锁）。
// ⇒ 任何一次改写都必须把文件里其他键一起带走：文件解析不出来时**不许**按空对象重建，
//    否则一次无关的写就把另外两把钥匙（含唯一的恢复途径）就地抹掉，且屏上没有任何地方会说。

/** 读 config.json 的共享入口；三种事实在这里分开：没有文件／读不出或解析失败／键本身不在 */
function readConfigFile(label: string): Record<string, unknown> | null {
  if (!existsSync(CONFIG_PATH)) return null
  let raw: string
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8')
  } catch (e) {
    log.warn(`${label}：config.json 在，但读不出（这一项按缺失处理）: ${errMsg(e)}`)
    return null
  }
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // 解析不出来＝手工编辑过／断电留下的半截文件，走下面那句留痕
  }
  log.warn(`${label}：config.json 解析失败（多半是被手工编辑过或写入时中断留下的半截文件），这一项按缺失处理`)
  return null
}

/**
 * 写路径专用的读：解析不出来时**先把原文件改名留档再新建**，而不是当空对象覆盖。
 * 留档改不了名（文件被占住、权限）就抛＝这次改写放弃——"宁可写不成，不可把没读出来的键当没有"。
 */
function loadConfigForWrite(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) return {}
  let raw: string
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8')
  } catch (e) {
    throw new Error(`config.json 读不出，本次不改写（同文件里的 salt／档位／恢复包不能被一次失败的读顶掉）: ${errMsg(e)}`)
  }
  try {
    const v = JSON.parse(raw) as unknown
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {
    // 落到下面的留档分支
  }
  const archive = `${CONFIG_PATH}.corrupt-${Date.now()}`
  renameSync(CONFIG_PATH, archive)
  log.warn(`config.json 解析失败 ⇒ 原文已留档 ${archive}，本次改写只带自己要落的那一把钥匙；其余键（含恢复包）请从那份留档取回`)
  return {}
}

/** 同目录独占临时文件 + rename 覆盖：中途崩溃/断电留下的是没人认识的 .tmp-*，不是半截的 config.json */
function saveConfigFile(cfg: Record<string, unknown>): void {
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`
  try {
    // 0600＋wx：文件名通用、未来可能承载其他敏感配置；独占建（已存在就失败）避免并发写互相顶掉
    writeFileSync(tmp, JSON.stringify(cfg, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, CONFIG_PATH)
  } catch (e) {
    try {
      unlinkSync(tmp)
    } catch {
      /* 临时文件没建成，不必再套一层错 */
    }
    throw new Error(`config.json 写入失败: ${errMsg(e)}`)
  }
}

/** 读改写的唯一出口：三个写点都走这里，确保"其他键带着走"只需要在这一处成立 */
function mutateConfigFile(mutate: (cfg: Record<string, unknown>) => void): void {
  const cfg = loadConfigForWrite()
  mutate(cfg)
  saveConfigFile(cfg)
}

// ---------- 主密码 salt 双通道 ----------
//
// salt 不是秘密（KDF 公开参数），但必须在 DB 未解锁/未打开时可读，
// 否则加密库会陷入「要读 salt 才能派生密钥解锁、要解锁才能读 salt」死锁
// （salt 存在加密库内，boot 解锁在无 key 连接上必失败）。
// 主通道：config.json（明文文件，随库无关）；DB 内保留一份兼容回退。

function readSaltFromConfigFile(): string | null {
  const cfg = readConfigFile('主密码 salt')
  const v = cfg?.masterPasswordSalt
  return typeof v === 'string' ? v : null
}

function writeSaltToConfigFile(b64: string | null): void {
  try {
    mutateConfigFile((cfg) => {
      if (b64 === null) delete cfg.masterPasswordSalt
      else cfg.masterPasswordSalt = b64
    })
  } catch (e) {
    // 写失败不阻塞主流程：DB 内仍有回退副本。但必须留痕——否则"文件里没 salt"这件事没人知道，
    // 而它下一次表现出来的位置是启动解锁那句"密码错误"
    log.warn(`salt 写 config.json 失败（DB 里的回退副本仍在）: ${errMsg(e)}`)
  }
}


// ---------- 恢复密钥包（库外通道） ----------
//
// 与 salt 同理但更严格：恢复包用于「忘记主密码」场景，此时 DB 无法打开，
// 包绝不能存进加密 DB（否则鸡生蛋）。只放 config.json，跟随便携目录走。
// 注意 config.json **不在备份包里**（备份只装 manifest.json＋app.db＋attachments；
// files-service 那张表是「禁止删除」的保护清单，不是备份清单），所以这个文件就是
// 恢复包的**唯一副本**——写它的那几条路径一旦把别的键当空对象重建，用户就再没有
// 任何一处能取回恢复码包。包内是「恢复码派生密钥加密后的 masterKey」，
// config.json 被读到也无法离线伪造（暴力破解恢复码）。

function readRecoveryBlobFromConfigFile(): string | null {
  const cfg = readConfigFile('恢复密钥包')
  const v = cfg?.recoveryBlob
  return typeof v === 'string' ? v : null
}

function writeRecoveryBlobToConfigFile(blob: string | null): void {
  try {
    mutateConfigFile((cfg) => {
      if (blob === null) delete cfg.recoveryBlob
      else cfg.recoveryBlob = blob
    })
  } catch (e) {
    throw new Error(`恢复密钥写入 config.json 失败: ${errMsg(e)}`)
  }
}


// ---------- 主密码 KDF 档位（SEC-32②） ----------
//
// 与 salt 完全同一个约束：DB 未解锁时也必须能读到，否则「要先知道档位才能派生、
// 要派生才能开库」死锁。主通道 config.json 的 kdfParams，DB 内留一份回退副本
// （config.json 被单独还原/删除时自愈）。
// 读出的值必须过白名单 normalizeKdfParams：config.json 是明文可编辑文件，
// 照搬一个巨大的 N 就能在同步的解锁路径上把主进程内存/时间打爆。

function readKdfFromConfigFile(): unknown {
  const cfg = readConfigFile('主密码 KDF 档位')
  return cfg?.kdfParams ?? null
}

function writeKdfToConfigFile(params: KdfParams | null): void {
  try {
    mutateConfigFile((cfg) => {
      if (params === null) delete cfg.kdfParams
      else cfg.kdfParams = params
    })
  } catch (e) {
    // 与 salt 那侧同口径：DB 里的回退副本仍在，所以不阻塞主流程，但必须留痕
    log.warn(`KDF 档位写 config.json 失败（DB 里的回退副本仍在）: ${errMsg(e)}`)
  }
}

// ---------- 内存读缓存 ----------
// app_config 是主进程单写者的键值表：写只经 set/delete（同步更新缓存），
// restore 整库替换 DB 文件后由 clearAppConfigCache() 失效。
// get 在热路径被高频调用（工具注册表 classify/execute 每步都读
// workspace_dir / shell 开关），每次打 SQLite 不必要；null 也缓存
// （key 未设置是常态，避免反复 miss 查库）。
const getCache = new Map<string, string | null>()

/** 清空 app_config 读缓存（restore 整库替换 DB 文件后必须调用） */
export function clearAppConfigCache(): void {
  getCache.clear()
}

export const appConfigRepo = {
  get(key: string): string | null {
    if (getCache.has(key)) return getCache.get(key)!
    const row = dbService
      .getHandle()
      .prepare('SELECT value FROM app_config WHERE key = ?')
      .get(key) as { value: string | null } | undefined
    const value = row?.value ?? null
    getCache.set(key, value)
    return value
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
    getCache.set(key, value)
  },

  delete(key: string): void {
    dbService.getHandle().prepare('DELETE FROM app_config WHERE key = ?').run(key)
    getCache.set(key, null)
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

  /**
   * 当前库的主密码派生档位（SEC-32②）。
   * 无记录 / 记录畸形 / 档位不在白名单 ⇒ 一律 KDF_LEGACY，
   * 保证升档功能上线前的所有库（以及被编辑过的 config.json）都按历史参数派生。
   */
  getKdfParams(): KdfParams {
    const fromFile = normalizeKdfParams(readKdfFromConfigFile())
    if (fromFile) return fromFile
    try {
      const raw = this.get(KEYS.MASTER_KDF)
      const fromDb = raw ? normalizeKdfParams(JSON.parse(raw)) : null
      if (fromDb) {
        // 回填自愈：boot 预开库阶段与恢复流程只读文件通道，不能让它们扑空
        writeKdfToConfigFile(fromDb)
        return fromDb
      }
    } catch { /* DB 未开或 JSON 损坏 → 按历史档 */ }
    return KDF_LEGACY
  },

  /** 落盘新档位：与 salt 一样双写（config.json 主通道 + DB 回退副本） */
  setKdfParams(params: KdfParams): void {
    writeKdfToConfigFile(params)
    this.set(KEYS.MASTER_KDF, JSON.stringify(params))
  },

  /** 禁用加密时清掉档位记录（回到无密码模式，不留下与库不符的标记） */
  clearKdfParams(): void {
    writeKdfToConfigFile(null)
    try { this.delete(KEYS.MASTER_KDF) } catch { /* DB 未开时忽略 */ }
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

  // ---------- 窗口行为（开机自启 / 关窗到托盘） ----------

  isLaunchAtLogin(): boolean {
    return this.get(KEYS.LAUNCH_AT_LOGIN) === '1'
  },

  setLaunchAtLogin(enabled: boolean): void {
    this.set(KEYS.LAUNCH_AT_LOGIN, enabled ? '1' : '0')
  },

  isCloseToTray(): boolean {
    return this.get(KEYS.CLOSE_TO_TRAY) === '1'
  },

  setCloseToTray(enabled: boolean): void {
    this.set(KEYS.CLOSE_TO_TRAY, enabled ? '1' : '0')
  },

  // ---------- 用量预算（¥，null=不限制） ----------

  getUsageBudgetDaily(): number | null {
    const v = this.get(KEYS.USAGE_BUDGET_DAILY)
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  },

  setUsageBudgetDaily(v: number | null): void {
    this.set(KEYS.USAGE_BUDGET_DAILY, v && v > 0 ? String(v) : '')
  },

  getUsageBudgetMonthly(): number | null {
    const v = this.get(KEYS.USAGE_BUDGET_MONTHLY)
    const n = v ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? n : null
  },

  setUsageBudgetMonthly(v: number | null): void {
    this.set(KEYS.USAGE_BUDGET_MONTHLY, v && v > 0 ? String(v) : '')
  },

  /** 预算硬阻断：达到日/月上限时是否自动停发请求（缺省关闭=仅 toast 提醒） */
  isUsageBudgetHardBlockEnabled(): boolean {
    return this.get(KEYS.USAGE_BUDGET_HARD_BLOCK) === '1'
  },

  setUsageBudgetHardBlock(enabled: boolean): void {
    this.set(KEYS.USAGE_BUDGET_HARD_BLOCK, enabled ? '1' : '')
  },

  /** 预算 80% 软预警开关：缺省=开（对齐 hard_block「空/缺省=仅提醒」原设计），仅显式 '0' 关闭 */
  isUsageBudgetWarnEnabled(): boolean {
    return this.get(KEYS.USAGE_BUDGET_WARN) !== '0'
  },

  setUsageBudgetWarn(enabled: boolean): void {
    this.set(KEYS.USAGE_BUDGET_WARN, enabled ? '1' : '0')
  },

  /** 本周期是否已弹过软预警（scope daily 传 YYYY-MM-DD，monthly 传 YYYY-MM） */
  isBudgetWarned(scope: 'daily' | 'monthly', periodKey: string): boolean {
    const prefix =
      scope === 'daily'
        ? KEYS.USAGE_BUDGET_WARNED_DAILY_PREFIX
        : KEYS.USAGE_BUDGET_WARNED_MONTHLY_PREFIX
    return this.get(prefix + periodKey) === '1'
  },

  markBudgetWarned(scope: 'daily' | 'monthly', periodKey: string): void {
    const prefix =
      scope === 'daily'
        ? KEYS.USAGE_BUDGET_WARNED_DAILY_PREFIX
        : KEYS.USAGE_BUDGET_WARNED_MONTHLY_PREFIX
    this.set(prefix + periodKey, '1')
  },

  // ---------- 网络代理（已 normalize 的 http/https URL；''=直连） ----------

  getProxyUrl(): string {
    return this.get(KEYS.NET_PROXY_URL) ?? ''
  },

  /** url 为空串时清除配置（恢复直连语义） */
  setProxyUrl(url: string): void {
    if (url === '') this.delete(KEYS.NET_PROXY_URL)
    else this.set(KEYS.NET_PROXY_URL, url)
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
