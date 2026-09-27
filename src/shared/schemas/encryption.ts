// 加密相关 IPC 入参 schema
// 密码/恢复码直接关系主密钥，必须严格校验类型与最小长度，
// 防止空串/非字符串等畸形输入进入 scrypt/AES 流程。
// max 上限防超长输入在 scrypt 前的哈希/填充阶段造成无谓 CPU 消耗。
import { z } from 'zod'

/** 主密码：非空字符串，最小 6 位（与 UnlockPage 前端约束一致），最长 128 */
export const masterPasswordSchema = z.string().min(6, '密码至少 6 位').max(128, '密码过长')

/** 恢复码：非空字符串，最长 64（恢复码为固定格式短串） */
export const recoveryCodeSchema = z.string().min(1, '恢复码不能为空').max(64, '恢复码过长')

/** ENCRYPTION_RECOVER 入参 */
export const recoverPayloadSchema = z.object({
  code: recoveryCodeSchema,
  newPassword: masterPasswordSchema
})
