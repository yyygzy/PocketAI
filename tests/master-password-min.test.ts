// SEC-32①：主密码长度下限按「路径」分档
//
// 校验路径（解锁 / 改密旧密码 / 禁用加密）必须仍是 6 位：历史上设过 6~9 位的
// 存量用户一旦被收紧，就直接锁死在门外（数据他们自己也无法解密）。
// 新设路径（boot 设密码 / 设置页启用加密 / 改密的新密码 / 恢复码重置）收紧到 10，
// 配合 scrypt 派生抬高「拿到 U 盘离线暴破」的成本。
import { describe, it, expect } from 'vitest'
import {
  masterPasswordSchema,
  newMasterPasswordSchema,
  recoverPayloadSchema,
  NEW_MASTER_PASSWORD_MIN
} from '../src/shared/schemas/encryption'

describe('主密码下限分档（SEC-32①）', () => {
  it('新设下限常量为 10（渲染层闸门与此同源）', () => {
    expect(NEW_MASTER_PASSWORD_MIN).toBe(10)
  })

  it('校验路径：6 位仍通过，5 位拒绝', () => {
    expect(masterPasswordSchema.safeParse('123456').success).toBe(true)
    expect(masterPasswordSchema.safeParse('12345').success).toBe(false)
  })

  it('新设路径：9 位拒绝、10 位通过', () => {
    expect(newMasterPasswordSchema.safeParse('123456789').success).toBe(false)
    expect(newMasterPasswordSchema.safeParse('1234567890').success).toBe(true)
  })

  it('新设路径的报错文案带上真实下限，避免 UI 与提示不一致', () => {
    const r = newMasterPasswordSchema.safeParse('abc')
    expect(r.success).toBe(false)
    if (r.success) throw new Error('短密码本应被拒绝')
    expect(r.error.issues[0]?.message).toContain(String(NEW_MASTER_PASSWORD_MIN))
  })

  it('恢复码重置走新设档（code 仍只要求非空）', () => {
    expect(recoverPayloadSchema.safeParse({ code: 'ABC123', newPassword: 'short' }).success).toBe(false)
    expect(recoverPayloadSchema.safeParse({ code: 'ABC123', newPassword: '1234567890' }).success).toBe(true)
    expect(recoverPayloadSchema.safeParse({ code: '', newPassword: '1234567890' }).success).toBe(false)
  })

  it('两侧上限仍为 128（超长输入不进 scrypt 前的填充阶段）', () => {
    const tooLong = 'x'.repeat(129)
    expect(masterPasswordSchema.safeParse(tooLong).success).toBe(false)
    expect(newMasterPasswordSchema.safeParse(tooLong).success).toBe(false)
  })
})
