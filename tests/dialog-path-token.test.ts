// 对话框路径令牌（src/main/ipc/dialog-path-token.ts，SEC-6 的机制本体）
//
// 钉住三条不变量：① 只有签发过的句柄能解析出路径（渲染端传不进任意路径）；
// ② peek 不消费（密码可连续重试多次），drop 后失效；③ 过期与容量上限兜底。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  issuePathToken,
  peekPathToken,
  dropPathToken,
  resetPathTokensForTest
} from '../src/main/ipc/dialog-path-token'

const TTL_MS = 10 * 60 * 1000

describe('dialog-path-token', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-08T00:00:00Z'))
    resetPathTokensForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('签发的句柄可解析回原路径', () => {
    const token = issuePathToken('/data/backups/a.zip')
    expect(token).toMatch(/^[0-9a-f-]{36}$/)
    expect(peekPathToken(token)).toBe('/data/backups/a.zip')
  })

  it('未签发 / 空 / 非字符串句柄都解析为 null（不接受裸路径）', () => {
    expect(peekPathToken('not-issued')).toBeNull()
    expect(peekPathToken(undefined)).toBeNull()
    expect(peekPathToken(null)).toBeNull()
    expect(peekPathToken('')).toBeNull()
  })

  it('peek 不消费：同一令牌可反复取用（密码重试场景）', () => {
    const token = issuePathToken('/x.zip')
    expect(peekPathToken(token)).toBe('/x.zip')
    expect(peekPathToken(token)).toBe('/x.zip')
  })

  it('drop 后失效', () => {
    const token = issuePathToken('/x.zip')
    dropPathToken(token)
    expect(peekPathToken(token)).toBeNull()
    expect(() => dropPathToken(token)).not.toThrow()
  })

  it('超过 TTL 的令牌失效（并在读取时被清掉）', () => {
    const token = issuePathToken('/x.zip')
    vi.advanceTimersByTime(TTL_MS + 1)
    expect(peekPathToken(token)).toBeNull()
  })

  it('TTL 内仍有效（边界）', () => {
    const token = issuePathToken('/x.zip')
    vi.advanceTimersByTime(TTL_MS - 1000)
    expect(peekPathToken(token)).toBe('/x.zip')
  })

  it('容量上限：超出后淘汰最早签发的令牌，新令牌仍可用', () => {
    const first = issuePathToken('/first.zip')
    for (let i = 0; i < 25; i++) issuePathToken(`/p${i}.zip`)
    expect(peekPathToken(first)).toBeNull()
    const latest = issuePathToken('/latest.zip')
    expect(peekPathToken(latest)).toBe('/latest.zip')
  })

  it('签发时顺带清理过期项（不会无限增长）', () => {
    issuePathToken('/old.zip')
    vi.advanceTimersByTime(TTL_MS + 1)
    const fresh = issuePathToken('/fresh.zip')
    expect(peekPathToken(fresh)).toBe('/fresh.zip')
  })

  it('同一文件重复签发得到互相独立的令牌', () => {
    const a = issuePathToken('/same.zip')
    const b = issuePathToken('/same.zip')
    expect(a).not.toBe(b)
    dropPathToken(a)
    expect(peekPathToken(b)).toBe('/same.zip')
  })
})
