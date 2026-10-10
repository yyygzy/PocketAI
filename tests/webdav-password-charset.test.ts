// SEC-37：WebDAV 口令可编码性的判定单元测试
//
// 划线依据是实测出来的「btoa 版 base64 能否编码」= Latin1（≤ U+00FF），
// 不是「是否 ASCII」。这里把边界两侧都钉住：
// 收得太紧会误杀 café/üñí 这类本来能用的口令，放得太松就让用户撞上一条英文 btoa 报错。
import { describe, it, expect } from 'vitest'
import {
  isWebdavPasswordUsable,
  WEBDAV_PASSWORD_MAX_CODE_POINT,
  WEBDAV_PASSWORD_CHARSET_MSG
} from '../src/shared/schemas/backup'

describe('isWebdavPasswordUsable', () => {
  it('空串可用（未填口令不该被字符集拦）', () => {
    expect(isWebdavPasswordUsable('')).toBe(true)
  })

  it('ASCII 与 Latin1 上界内字符可用', () => {
    expect(isWebdavPasswordUsable('plain-ascii-9f3c')).toBe(true)
    expect(isWebdavPasswordUsable('café-crème-üñí')).toBe(true)
    // 符号也在 Latin1 内：收成纯 ASCII 会把这些误杀
    expect(isWebdavPasswordUsable('¥§±')).toBe(true)
  })

  it('恰好越界一个码位就拒', () => {
    expect(WEBDAV_PASSWORD_MAX_CODE_POINT).toBe(0xff)
    expect(isWebdavPasswordUsable(String.fromCharCode(0xff))).toBe(true)
    expect(isWebdavPasswordUsable(String.fromCharCode(0x100))).toBe(false)
  })

  it('中文、掩码前缀、emoji、组合记号都不可用', () => {
    expect(isWebdavPasswordUsable('中文口令')).toBe(false)
    // 掩码用的 `•`（U+2022）本身就不可编码 ⇒ 掩码绝不能被当成口令发出去
    expect(isWebdavPasswordUsable('••••9f3c')).toBe(false)
    expect(isWebdavPasswordUsable('🔑-backup')).toBe(false) // 代理对：按码位判定，不是按 charCodeAt
    expect(isWebdavPasswordUsable('cafe\u0301')).toBe(false) // 分解形式的 é 已越界
  })

  it('拒绝文案自带指路（不是一句「非法字符」）', () => {
    expect(WEBDAV_PASSWORD_CHARSET_MSG).toContain('应用专用密码')
    expect(WEBDAV_PASSWORD_CHARSET_MSG).not.toContain('Latin1 range') // 别把底层英文报错原样抛给用户
  })
})
