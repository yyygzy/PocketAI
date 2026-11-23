// Jev 语义审核增强开关（Ollama ≥0.35 的 /v1/systemone）。
//
// 定位：给现有「规则式工具审批」补一路**语义风险信号**，不是替代它。
//  - 只在用户显式开启时生效，默认关（fail-open：开关关/决策失败都保持原判定）；
//  - 决策用 score 题型给"这次工具调用有多冒险"打分，超阈值把 allow 提升为 confirm，
//    交给现成的 createApproval 走用户确认——不新造弹窗、不改审批事件顺序；
//  - 只存全局单键（app_config），不建表、不加迁移。
import { appConfigRepo } from '../db/repositories/app-config.repo'

const K_JEV_REVIEW_ENABLED = 'agent.jev_review_enabled'
/** 决策用的本地模型名；空＝用默认 tev1:0.8b（轻量、已实测可用） */
const K_JEV_MODEL = 'agent.jev_model'
/** 风险分阈值：score ≥ 此值（0-1）时把 allow 提升为 confirm */
const K_JEV_THRESHOLD = 'agent.jev_review_threshold'

export const JEV_DEFAULT_MODEL = 'tev1:0.8b'
export const JEV_DEFAULT_THRESHOLD = 0.7
const MODEL_RE = /^[\w.\-:]+$/
const MAX_MODEL_CHARS = 128

function readFlag(key: string): boolean {
  return appConfigRepo.get(key) === '1'
}

export function isJevReviewEnabled(): boolean {
  return readFlag(K_JEV_REVIEW_ENABLED)
}

export function setJevReviewEnabled(on: boolean): void {
  appConfigRepo.set(K_JEV_REVIEW_ENABLED, on ? '1' : '0')
}

export function getJevModel(): string {
  const raw = (appConfigRepo.get(K_JEV_MODEL) ?? '').trim()
  return raw && MODEL_RE.test(raw) && raw.length <= MAX_MODEL_CHARS ? raw : JEV_DEFAULT_MODEL
}

/** 返回 null 表示输入非法、不改库；空串＝回默认 */
export function setJevModel(value: string): string | null {
  const v = String(value ?? '').trim()
  if (v && (!MODEL_RE.test(v) || v.length > MAX_MODEL_CHARS)) return null
  appConfigRepo.set(K_JEV_MODEL, v)
  return v || JEV_DEFAULT_MODEL
}

export function getJevThreshold(): number {
  const stored = appConfigRepo.get(K_JEV_THRESHOLD)
  if (stored == null || String(stored).trim() === '') return JEV_DEFAULT_THRESHOLD
  const raw = Number(stored)
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : JEV_DEFAULT_THRESHOLD
}

/** 返回 null 表示输入非法、不改库 */
export function setJevThreshold(value: number): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 1) return null
  appConfigRepo.set(K_JEV_THRESHOLD, String(n))
  return n
}

export interface JevReviewPrefs {
  enabled: boolean
  model: string
  threshold: number
}

export function getJevReviewPrefs(): JevReviewPrefs {
  return { enabled: isJevReviewEnabled(), model: getJevModel(), threshold: getJevThreshold() }
}
