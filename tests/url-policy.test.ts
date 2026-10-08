// SEC-16：Provider baseUrl 的协议口径
//
// 两处收口都在这里验：
// - shared/url-policy：缺协议补 https（回环例外补 http）、明文远程 http 识别
// - providers/types.normalizeBaseUrl：实际出网 URL 的拼装结果
// 判据口径与 schemas/mcp.ts 的 pip 源例外、channels/gateway-base.ts 的回环例外一致。
import { describe, it, expect } from 'vitest'
import { ensureScheme, isPlainRemoteHttp, isLoopbackHost, urlHost } from '../src/shared/url-policy'
import { normalizeBaseUrl } from '../src/main/providers/types'

describe('ensureScheme', () => {
  it('远程地址缺协议 → 补 https，不再默认明文', () => {
    expect(ensureScheme('api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
  })

  it('回环地址缺协议 → 补 http（Ollama / LM Studio 的既有惯例）', () => {
    expect(ensureScheme('localhost:11434/v1')).toBe('http://localhost:11434/v1')
    expect(ensureScheme('127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1')
    expect(ensureScheme('[::1]:11434/v1')).toBe('http://[::1]:11434/v1')
  })

  it('已带协议 → 原样返回，不擅自升级用户显式写的 http', () => {
    expect(ensureScheme('http://192.168.1.20:8000/v1')).toBe('http://192.168.1.20:8000/v1')
    expect(ensureScheme('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas/v4')
  })

  it('无法解析的输入 → 仍按 https 补（宁可连不上，不明文带 Key）', () => {
    expect(ensureScheme('not a url')).toBe('https://not a url')
  })
})

describe('isPlainRemoteHttp（要求确认的风险态）', () => {
  it('远程 http → true', () => {
    expect(isPlainRemoteHttp('http://api.example.com/v1')).toBe(true)
    expect(isPlainRemoteHttp('http://192.168.1.20:11434/v1')).toBe(true)
  })

  it('回环 http → false（本地服务不打扰）', () => {
    expect(isPlainRemoteHttp('http://localhost:11434/v1')).toBe(false)
    expect(isPlainRemoteHttp('http://127.0.0.1:1234/v1')).toBe(false)
    expect(isPlainRemoteHttp('http://[::1]:11434/v1')).toBe(false)
  })

  it('https 与空/畸形输入 → false', () => {
    expect(isPlainRemoteHttp('https://api.openai.com/v1')).toBe(false)
    expect(isPlainRemoteHttp('')).toBe(false)
    expect(isPlainRemoteHttp('api.openai.com/v1')).toBe(false)
  })

  it('localhost 前缀伪装域名仍算远程', () => {
    expect(isPlainRemoteHttp('http://localhost.evil.example/v1')).toBe(true)
  })
})

describe('urlHost / isLoopbackHost', () => {
  it('大小写与端口无关', () => {
    expect(urlHost('http://LOCALHOST:11434/v1')).toBe('localhost')
    expect(isLoopbackHost(urlHost('https://127.0.0.1'))).toBe(true)
    expect(isLoopbackHost(urlHost('https://example.com'))).toBe(false)
    expect(isLoopbackHost(null)).toBe(false)
  })
})

describe('normalizeBaseUrl', () => {
  it('缺协议的远程地址规范化为 https + /v1', () => {
    expect(normalizeBaseUrl('api.deepseek.com')).toBe('https://api.deepseek.com/v1')
  })

  it('末尾斜杠去掉，已有版本段不重复补', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1')
  })

  it('本地服务缺协议仍是 http，不被改坏', () => {
    expect(normalizeBaseUrl('localhost:11434')).toBe('http://localhost:11434/v1')
  })
})
