// 加密相关 IPC 入参 schema
// 密码/恢复码直接关系主密钥，必须严格校验类型与最小长度，
// 防止空串/非字符串等畸形输入进入 scrypt/AES 流程。
// max 上限防超长输入在 scrypt 前的哈希/填充阶段造成无谓 CPU 消耗。
import { z } from 'zod'

/** 新设主密码下限：校验路径不用它（存量 6~9 位用户必须仍能解锁） */
export const NEW_MASTER_PASSWORD_MIN = 10

/** 主密码（校验路径）：非空字符串，最小 6 位，最长 128。
 *  下限只用于「验证已有密码」（解锁 / 改密旧密码 / 禁用加密）——收紧到 10 会把
 *  历史上设过 6~9 位的存量用户直接锁死，故校验与设置必须用不同 schema。 */
export const masterPasswordSchema = z.string().min(6, '密码至少 6 位').max(128, '密码过长')

/** 主密码（新设路径）：下限 10。配合 scrypt 派生，抵御「拿到 U 盘离线暴破」 */
export const newMasterPasswordSchema = z.string()
  .min(NEW_MASTER_PASSWORD_MIN, `新密码至少 ${NEW_MASTER_PASSWORD_MIN} 位`)
  .max(128, '密码过长')

/** 恢复码：非空字符串，最长 64（恢复码为固定格式短串） */
export const recoveryCodeSchema = z.string().min(1, '恢复码不能为空').max(64, '恢复码过长')

/** ENCRYPTION_RECOVER 入参 */
export const recoverPayloadSchema = z.object({
  code: recoveryCodeSchema,
  newPassword: newMasterPasswordSchema
})
