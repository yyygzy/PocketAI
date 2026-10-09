// none 模式下的新密钥写入闸（SEC-1 方案 B2）
//
// 为什么拦：未设主密码时字段「加密」用的是源码里公开的固定口令+固定盐（见 master-key.ts），
// 任何人可复现该密钥，密文等同明文。把**新**密钥写进这种密文，只会制造「已受保护」的错觉，
// 所以直接拒绝并指路，而不是静默混淆落盘。
// 为什么不更严：
// - 掩码往返（只改名称/命令/参数）回填的是已存在的值 → 不在本闸范围，照常保存；
// - 删除某个键、把同一个值挪到别的键下 → 没有新增密钥材料，放行；
// - 历史明文迁移与主密码轮换走 repo 的 migratePlaintextSecrets / restoreAllSecrets，
//   加密模式切换流程直接调 backup-service 的 saveWebDAVConfig，均不经过本闸。
import { masterKeyManager } from './master-key'

/** 引导语：两处拒绝文案共用，避免口径漂移 */
export const NONE_MODE_HINT = '请先在「设置 → 数据加密」中设置主密码后重试。'

/** 是否处于未设主密码的明文模式 */
export function isNoneMode(): boolean {
  return masterKeyManager.getMode() === 'none'
}

/**
 * next 相对 existing 新出现的密钥值所对应的键名。
 * 按**值**判定而非按键名：改键名不算新增，改值算新增。键名可展示，值不外泄。
 */
export function newSecretKeys(
  next: Record<string, string> | null | undefined,
  existing: Record<string, string> | null | undefined
): string[] {
  const known = new Set(Object.values(existing ?? {}).filter((v) => v !== ''))
  return Object.entries(next ?? {})
    .filter(([, v]) => v !== '' && !known.has(v))
    .map(([k]) => k)
}

/**
 * 汇总若干待写入映射：none 模式且有新密钥值时返回拒绝文案，否则返回 null。
 * 调用方决定抛错还是返回结构化失败。
 */
export function noneModeSecretBlock(
  targets: Array<{ field: string; next: Record<string, string>; existing?: Record<string, string> }>
): string | null {
  if (!isNoneMode()) return null
  const hits: string[] = []
  for (const t of targets) {
    const keys = newSecretKeys(t.next, t.existing)
    if (keys.length > 0) hits.push(`${t.field}：${keys.join('、')}`)
  }
  if (hits.length === 0) return null
  return `未设置主密码，新密钥不会被保存（${hits.join('；')}）。${NONE_MODE_HINT}`
}
