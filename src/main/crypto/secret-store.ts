// app_config KV 敏感凭据的统一加密存取
//
// 适用：Telegram bot token、联网搜索 API Key 等「单值密钥」类配置。
// 落盘为字段级密文（v1: AES-256-GCM，密钥随加密模式：
// db 模式=主密码派生密钥，none 模式=固定混淆密钥），明文只在主进程内存出现。
//
// 配套机制：
// - migrateKvSecrets()：boot 时一次性把历史明文升级为密文（幂等）
// - exportSecrets()/restoreSecrets()：主密码启用/禁用/轮换时随字段密钥重加密

import { appConfigRepo } from '../db/repositories/app-config.repo'
import { dbService } from '../db/database'
import {
  encryptSecret,
  decryptSecret,
  isCipherText,
  hasUndecryptableCipher,
  wirePlaintextMigrationMarker,
  markPlaintextMigrationDone,
  clearPlaintextMigrationDone,
  PLAINTEXT_MIGRATION_DONE_KEY
} from './field-encrypt'

// SEC-16-07：把「明文迁移已完成」标记的读/写接进 field-encrypt（见彼处的依赖方向说明）。
// 标记落在 app_config：读走 appConfigRepo 的缓存；DB 未打开时按「未完成」＝明文直通。
wirePlaintextMigrationMarker(
  () => {
    try {
      return appConfigRepo.get(PLAINTEXT_MIGRATION_DONE_KEY) === '1'
    } catch {
      return false
    }
  },
  {
    mark: () => appConfigRepo.set(PLAINTEXT_MIGRATION_DONE_KEY, '1'),
    clear: () => appConfigRepo.delete(PLAINTEXT_MIGRATION_DONE_KEY)
  }
)
import { createLogger } from '../logger'
import { errMsg } from '../error'
import { z } from 'zod'

const log = createLogger('crypto')

/** 受管 KV 键（唯一登记处；新增密钥类配置在此注册） */
export const SECRET_KV_KEYS = {
  TELEGRAM_TOKEN: 'channel.tg_token',
  FEISHU_APP_SECRET: 'channel.feishu_app_secret',
  DINGTALK_APP_SECRET: 'channel.dingtalk_app_secret',
  SLACK_BOT_TOKEN: 'channel.slack_bot_token',
  SLACK_APP_TOKEN: 'channel.slack_app_token',
  DISCORD_BOT_TOKEN: 'channel.discord_bot_token',
  /** 历史单槽 Key（启动时一次性迁移到按 provider 的键，见 websearch-config.migrateLegacyWebSearchKey） */
  WEBSEARCH_API_KEY: 'agent.websearch_api_key',
  WEBSEARCH_TAVILY_KEY: 'agent.websearch_tavily_key',
  WEBSEARCH_BOCHA_KEY: 'agent.websearch_bocha_key'
} as const

/** key 必须是已注册的受管密钥，防止任意 key 污染 app_config */
const secretKeySchema = z.enum(Object.values(SECRET_KV_KEYS) as [string, ...string[]])
/** 单值密钥长度上限（token/API key 通常远小于此；兜底防巨串写入） */
const secretValueSchema = z.string().max(1024)

/** 加密写入；空串/纯空白 = 删除凭据 */
export function setSecret(key: string, value: string): void {
  const k = secretKeySchema.parse(key)
  const raw = secretValueSchema.parse(value)
  const v = raw.trim()
  if (!v) {
    appConfigRepo.delete(k)
    return
  }
  appConfigRepo.set(k, encryptSecret(v))
}

/** 解密读取（不存在/解密失败 → 空串）；历史明文透明兼容 */
export function getSecret(key: string): string {
  return decryptSecret(appConfigRepo.get(key))
}

/** 是否已配置凭据（只看落盘有无值，不触发解密） */
export function hasSecret(key: string): boolean {
  return !!appConfigRepo.get(key)
}

/**
 * SEC-16-07 迁移收尾的扫描面：三处明文凭据（provider.api_key_encrypted /
 * mcp_servers.env+headers / SECRET_KV_KEYS 登记的 KV）里还有没有非密文形状的值。
 * 只读查询，不改任何 repo。WebDAV 口令不在列：saveWebDAVConfig 从落盘起就写密文信封，
 * 且它在 JSON 配置串里层，不属于这三个迁移函数的管辖面。
 */
function hasPlaintextSecretsLeft(): boolean {
  const db = dbService.getHandle()
  const providerRows = db
    .prepare(
      "SELECT api_key_encrypted AS v FROM providers WHERE api_key_encrypted IS NOT NULL AND api_key_encrypted != ''"
    )
    .all() as { v: string }[]
  if (providerRows.some((r) => !isCipherText(r.v))) return true
  const mcpRows = db.prepare('SELECT env, headers FROM mcp_servers').all() as {
    env: string | null
    headers: string | null
  }[]
  if (mcpRows.some((r) => (r.env && !isCipherText(r.env)) || (r.headers && !isCipherText(r.headers)))) {
    return true
  }
  for (const key of Object.values(SECRET_KV_KEYS)) {
    const raw = appConfigRepo.get(key)
    if (raw && !isCipherText(raw)) return true
  }
  return false
}

/**
 * 历史明文 → 密文的一次性升级（幂等）。
 * 必须在字段密钥可用时调用（DB 打开且解锁完成后）。
 *
 * SEC-16-07 收尾接线：index.ts 阶段 3 把三个明文迁移同步连跑
 * （migrateKvSecrets → migrateLegacyWebSearchKey → providerRepo.migratePlaintextKeys
 * → mcpServerRepo.migratePlaintextSecrets），而后两个迁移本体经
 * decryptApiKeys/decryptSecretMap → decryptSecret 读值——迁移期必须保持明文直通。
 * 所以「明文迁移已完成」标记不能在本函数同步落：
 * 1. 入口先扫一遍：发现明文残留（含上次启动标记已落但数据又回到了明文，如合并旧云备份）
 *    就撤回标记，让本次整个迁移块稳定工作在直通通道上——否则迁移本体把明文读成空串，
 *    会把空密文写回去＝凭据被清空；
 * 2. 排一个宏任务（setTimeout 0）等阶段 3 整个同步块跑完，再扫一遍确认无明文残留才落标记；
 *    迁移中途抛错（index.ts 只 warn 不阻塞启动）时扫得出残留，标记不落＝保持直通，
 *    下个启动重试迁移，绝不把「迁移失败」误当成「迁移完成」。
 */
export function migrateKvSecrets(keys: readonly string[] = Object.values(SECRET_KV_KEYS)): void {
  // 入口扫描（DB 不可用＝按未标记处理，等宏任务里再试）
  try {
    if (hasPlaintextSecretsLeft()) clearPlaintextMigrationDone()
  } catch {
    /* DB 未打开等：标记维持原状 */
  }
  for (const key of keys) {
    const raw = appConfigRepo.get(key)
    if (raw && !isCipherText(raw)) {
      appConfigRepo.set(key, encryptSecret(raw))
      log.info(`KV 凭据已升级为字段加密: ${key}`)
    }
  }
  setTimeout(() => {
    try {
      if (hasPlaintextSecretsLeft()) {
        log.warn('仍存在明文凭据（迁移未完成或中途失败），fail-closed 门保持关闭（本次启动明文直通）')
        return
      }
      markPlaintextMigrationDone()
      log.info('明文凭据迁移收尾完成：字段读取进入 fail-closed')
    } catch (e) {
      log.warn('迁移完成标记写入失败（保持明文直通，下个启动重试）:', errMsg(e))
    }
  }, 0)
}

/** 密钥轮换前：用「旧字段密钥」导出明文快照（仅进程内存）；解不开的行单列进 undecryptable（§375，不进快照＝保持原密文不动） */
export function exportSecrets(
  keys: readonly string[] = Object.values(SECRET_KV_KEYS)
): { snapshot: Record<string, string>; undecryptable: string[] } {
  const snapshot: Record<string, string> = {}
  const undecryptable: string[] = []
  for (const key of keys) {
    try {
      const raw = appConfigRepo.get(key)
      const v = getSecret(key)
      if (v) snapshot[key] = v
      else if (hasUndecryptableCipher(raw)) undecryptable.push(key)
    } catch (e) {
      log.warn(`轮换导出失败 ${key}:`, errMsg(e))
    }
  }
  return { snapshot, undecryptable }
}

/** 密钥轮换后：用「新字段密钥」重新加密落盘；空快照对应键保持删除态 */
export function restoreSecrets(snapshot: Record<string, string>): void {
  // 仅校验值类型（string + 长度上限），key 的合法性由 setSecret 内的 secretKeySchema 兜底；
  // 注意：z.record(secretKeySchema, ...) 在 Zod 4 下会把所有 enum key 视为必填，
  // 而 exportSecrets 只导出有值的 key，故此处不能用 enum 作为 key schema。
  const parsed = z.record(z.string(), secretValueSchema).parse(snapshot)
  for (const [key, value] of Object.entries(parsed)) {
    try {
      setSecret(key, value)
    } catch (e) {
      log.warn(`轮换恢复失败 ${key}:`, errMsg(e))
    }
  }
}
