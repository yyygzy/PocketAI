// KB 问答历史自动清理策略 KV 读写（app_config 键 kbAsk.retention）
// 默认双 0 = 关闭：不静默删用户数据，用户显式设置后才在每次保存会话时顺手 prune。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { KbAskRetention } from '../../shared/types'

const K_KB_ASK_RETENTION = 'kbAsk.retention'

const RETENTION_OFF: KbAskRetention = { keepCount: 0, keepDays: 0 }

/** 容错解析：坏 JSON/缺字段/非法值一律回退关闭态 */
export function parseKbAskRetention(raw: unknown): KbAskRetention {
  if (!raw || typeof raw !== 'object') return { ...RETENTION_OFF }
  const o = raw as Record<string, unknown>
  const num = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  return { keepCount: num(o.keepCount), keepDays: num(o.keepDays) }
}

/** 读取保留策略；无配置/坏 JSON 时回退 {keepCount:0, keepDays:0}（关闭） */
export function getKbAskRetention(): KbAskRetention {
  const raw = appConfigRepo.get(K_KB_ASK_RETENTION)
  if (!raw) return { ...RETENTION_OFF }
  try {
    return parseKbAskRetention(JSON.parse(raw))
  } catch {
    return { ...RETENTION_OFF }
  }
}

/** 持久化保留策略（调用方应已过 zod 校验） */
export function setKbAskRetention(policy: KbAskRetention): void {
  appConfigRepo.set(K_KB_ASK_RETENTION, JSON.stringify(policy))
}
