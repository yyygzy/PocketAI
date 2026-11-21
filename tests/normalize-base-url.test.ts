// normalizeBaseUrl Provider Base URL 标准化测试
//
// 覆盖 src/main/providers/types.ts 的 normalizeBaseUrl：
// - trim 空白
// - 去除末尾斜杠
// - 无 http(s):// 前缀 → 补 https://（SEC-16：回环地址例外补 http，保 Ollama / LM Studio）
// - 无 /vN 版本后缀 → 补 /v1
//
// 策略：纯函数，无依赖，直接测试。
import { describe, it, expect } from 'vitest'
import { normalizeBaseUrl } from '../src/main/providers/types'

describe('normalizeBaseUrl — Base URL 标准化', () => {
  it('已有 https + /v1 → 原样（去末尾斜杠）', () => {
    expect(normalizeBaseUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1')
  })

  it('末尾多个斜杠 → 去除', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1///')).toBe('https://api.example.com/v1')
  })

  it('前后空白 → trim', () => {
    expect(normalizeBaseUrl('  https://api.example.com/v1  ')).toBe('https://api.example.com/v1')
  })

  it('无协议 → 补 https://（SEC-16：不再默认明文带 Key）', () => {
    expect(normalizeBaseUrl('api.example.com')).toBe('https://api.example.com/v1')
  })

  it('无协议的本地服务 → 仍补 http://（Ollama/LM Studio 惯例）', () => {
    expect(normalizeBaseUrl('localhost:11434')).toBe('http://localhost:11434/v1')
    expect(normalizeBaseUrl('127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1')
  })

  it('无 /vN 后缀 → 补 /v1', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe('https://api.example.com/v1')
  })

  it('已有 /v2 后缀 → 保留不补 /v1', () => {
    expect(normalizeBaseUrl('https://api.example.com/v2')).toBe('https://api.example.com/v2')
  })

  it('已有 /v1 且末尾斜杠 → 去斜杠保留 /v1', () => {
    expect(normalizeBaseUrl('https://api.example.com/v1/')).toBe('https://api.example.com/v1')
  })

  it('http 协议 + 无版本 → 补 /v1', () => {
    expect(normalizeBaseUrl('http://localhost:8080')).toBe('http://localhost:8080/v1')
  })

  it('http 协议 + /v1 → 原样', () => {
    expect(normalizeBaseUrl('http://localhost:8080/v1')).toBe('http://localhost:8080/v1')
  })

  it('大写 HTTPS → 保留（不区分大小写匹配协议）', () => {
    expect(normalizeBaseUrl('HTTPS://api.example.com/v1')).toBe('HTTPS://api.example.com/v1')
  })
})

describe('normalizeBaseUrl — SSRF 边界（M9）', () => {
  it('非回环明文 http → 拒绝（明文携带 API Key）', () => {
    expect(() => normalizeBaseUrl('http://api.example.com/v1')).toThrow(/https/)
  })

  it('字面内网/保留地址 → 拒绝；回环仍放行', () => {
    for (const url of [
      'https://127.0.0.1/v1', // 回环放行（见下）
    ]) {
      expect(() => normalizeBaseUrl(url)).not.toThrow()
    }
    for (const url of [
      'https://10.0.0.5/v1',
      'https://192.168.1.10/v1',
      'https://169.254.169.254/v1',
      'https://nas.local/v1'
    ]) {
      expect(() => normalizeBaseUrl(url)).toThrow(/内网|保留/)
    }
  })
})
