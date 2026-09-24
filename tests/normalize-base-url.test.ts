// normalizeBaseUrl Provider Base URL 标准化测试
//
// 覆盖 src/main/providers/types.ts 的 normalizeBaseUrl：
// - trim 空白
// - 去除末尾斜杠
// - 无 http(s):// 前缀 → 补 http://
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

  it('无协议 → 补 http://', () => {
    expect(normalizeBaseUrl('api.example.com')).toBe('http://api.example.com/v1')
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
