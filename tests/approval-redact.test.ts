// 审批参数脱敏（P0-2c-1）：键名规则复用 log-redact，额外补文本级真实向量
import { describe, it, expect } from 'vitest'
import { redactArgsForAudit, redactAuditText } from '../src/main/security/audit-redact'

describe('键名级脱敏（复用 redactLogValue）', () => {
  it('JSON 里的 authorization / api_key / token 键整值替换', () => {
    const out = redactArgsForAudit(JSON.stringify({
      authorization: 'Bearer abc.def.ghi',
      api_key: 'sk-live-123',
      token: 'tok-xyz',
      command: 'ls -la'
    }))
    expect(out).not.toContain('Bearer abc.def.ghi')
    expect(out).not.toContain('sk-live-123')
    expect(out).not.toContain('tok-xyz')
    expect(out).toContain('[redacted]')
    expect(out).toContain('ls -la')
  })

  it('非 JSON 原文直接走文本级规则（shell 命令场景）', () => {
    const out = redactArgsForAudit('curl -H "Authorization: Bearer sk-abc123" https://x.test/')
    expect(out).not.toContain('sk-abc123')
    expect(out).toContain('Authorization: [redacted]')
  })
})

describe('文本级真实向量', () => {
  it('Authorization: Bearer xxx', () => {
    const out = redactAuditText('Authorization: Bearer eyJhbGciOi.payload.sig')
    expect(out).toBe('Authorization: [redacted]')
  })

  it('URL query token', () => {
    const out = redactAuditText('https://api.test/v1?token=secret-token&page=1')
    expect(out).not.toContain('secret-token')
    expect(out).toContain('token=[redacted]')
    expect(out).toContain('page=1')
  })

  it('api_key=', () => {
    const out = redactAuditText('api_key=sk-proj-123456&model=x')
    expect(out).not.toContain('sk-proj-123456')
    expect(out).toContain('api_key=[redacted]')
  })

  it('secret= 与 password=', () => {
    const out = redactAuditText('secret=abc;password=hunter2')
    expect(out).not.toContain('abc')
    expect(out).not.toContain('hunter2')
    expect(out).toContain('secret=[redacted]')
    expect(out).toContain('password=[redacted]')
  })
})

describe('长度封顶', () => {
  it('超过 2000 字符截断并留下原长提示', () => {
    const raw = 'x'.repeat(3000)
    const out = redactAuditText(raw)
    expect(out.length).toBeGreaterThan(2000)
    expect(out.startsWith('x'.repeat(2000))).toBe(true)
    expect(out).toContain('已截断')
  })
})
