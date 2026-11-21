// OAuth 纯逻辑闸门：PKCE/state、端点安全策略、错误人话化（不透传原始 error_description）。
import { describe, expect, it } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { createOauthState, createPkcePair, safeStateEqual } from '../src/main/mcp/oauth/pkce'
import {
  humanizeOauthError,
  oauthCodeMessage,
  parseOauthErrorCode
} from '../src/main/mcp/oauth/errors'
import { isOpenableOauthUrl, oauthEndpointProblem } from '../src/shared/mcp-oauth'

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

describe('PKCE / state', () => {
  it('S256 challenge 与 verifier 对得上，长度符合 RFC 7636', () => {
    const pair = createPkcePair()
    expect(pair.method).toBe('S256')
    // 32 字节随机 → base64url 43 字符
    expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(pair.challenge).toBe(base64url(createHash('sha256').update(pair.verifier, 'ascii').digest()))
  })

  it('每次生成都不同，state 定长比较只认完全一致', () => {
    expect(createPkcePair().verifier).not.toBe(createPkcePair().verifier)
    const state = createOauthState()
    expect(state).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(safeStateEqual(state, state)).toBe(true)
    // 末位恰好就是 'x' 时直接替换会得到同一个串（1/64 概率误报）⇒ 挑一个确定不同的字符
    const flipped = state.slice(0, -1) + (state.endsWith('x') ? 'y' : 'x')
    expect(safeStateEqual(state, flipped)).toBe(false)
    expect(safeStateEqual(state, base64url(randomBytes(24)))).toBe(false)
    expect(safeStateEqual(state, 'short')).toBe(false)
  })
})

describe('OAuth 端点安全闸', () => {
  it('只放行 https；本机回环允许 http', () => {
    expect(oauthEndpointProblem('https://auth.example.com/token')).toBeNull()
    expect(oauthEndpointProblem('http://127.0.0.1:8080/token')).toBeNull()
    expect(oauthEndpointProblem('http://localhost:3000/authorize')).toBeNull()
    expect(oauthEndpointProblem('http://auth.example.com/token')).toMatch(/必须是 https/)
    expect(oauthEndpointProblem('')).toMatch(/不能为空/)
    expect(oauthEndpointProblem('not a url')).toMatch(/不是合法地址/)
  })

  it('拒绝账号密码与私网地址', () => {
    expect(oauthEndpointProblem('https://user:pass@auth.example.com/token')).toMatch(/账号密码/)
    expect(oauthEndpointProblem('https://10.0.0.8/token')).toMatch(/内网/)
    expect(oauthEndpointProblem('https://192.168.1.2/token')).toMatch(/内网/)
    // 本机回环即便命中私网段也放行
    expect(oauthEndpointProblem('http://127.0.0.1:9000/cb')).toBeNull()
  })

  it('打开浏览器前只认 http/https', () => {
    expect(isOpenableOauthUrl('https://auth.example.com/authorize?x=1')).toBe(true)
    expect(isOpenableOauthUrl('http://127.0.0.1:1234/cb')).toBe(true)
    expect(isOpenableOauthUrl('javascript:alert(1)')).toBe(false)
    expect(isOpenableOauthUrl('file:///etc/passwd')).toBe(false)
    expect(isOpenableOauthUrl('')).toBe(false)
  })
})

describe('OAuth 错误人话化', () => {
  it('已知错误码有固定人话，未知码不拼原始 description', () => {
    expect(oauthCodeMessage('invalid_grant')).toMatch(/重新授权/)
    expect(oauthCodeMessage('weird_code')).toBeNull()
    const raw = new Error('invalid_client: client_secret mismatch at 10.0.0.1')
    const text = humanizeOauthError(raw)
    expect(text).toMatch(/授权已失效或被服务端拒绝/)
    expect(text).not.toContain('client_secret')
    expect(text).not.toContain('10.0.0.1')
  })

  it('超时/网络/5xx 各有可行动提示；空错误有兜底', () => {
    expect(humanizeOauthError(new Error('request timed out'))).toMatch(/授权超时/)
    expect(humanizeOauthError(new Error('fetch failed: ENOTFOUND'))).toMatch(/无法连接授权服务器/)
    expect(humanizeOauthError(new Error('HTTP 502'))).toMatch(/暂时不可用/)
    expect(humanizeOauthError('')).toMatch(/授权未完成/)
    // 已是中文业务提示则原样保留
    expect(humanizeOauthError(new Error('未设置主密码，无法保存授权凭据'))).toBe('未设置主密码，无法保存授权凭据')
  })

  it('token 端点错误只取 error 码，不读 error_description', () => {
    expect(parseOauthErrorCode({ error: 'invalid_grant', error_description: 'secret detail' })).toBe(
      'invalid_grant'
    )
    expect(parseOauthErrorCode({ error_description: 'secret detail' })).toBeNull()
    expect(parseOauthErrorCode(null)).toBeNull()
  })
})
