// 联网调研后的防御性加固回归：
//  ① RFC 9207：OAuth 回调/令牌响应的 iss 校验 + DCR application_type + HTTP 协议版本头
//  ② 远程技能目录包：manifest 可选 Ed25519 签名验签（fail-closed）
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { generateKeyPairSync, sign } from 'node:crypto'
import { canonicalJson } from '../src/shared/mcp-catalog-trust'
import { verifySkillDirManifestSignature } from '../src/main/skills/skill-dir-trust'
import type { SkillDirManifest } from '../src/main/skills/skill-remote-dir'

describe('MCP RFC 9207 与协议加固（源码闸门）', () => {
  const loopback = readFileSync('src/main/mcp/oauth/loopback.ts', 'utf8')
  const service = readFileSync('src/main/mcp/oauth/service.ts', 'utf8')
  const http = readFileSync('src/main/mcp/http-transport.ts', 'utf8')

  it('回环回调保留 iss，redeem 前校验与 metadata issuer 一致', () => {
    expect(loopback).toMatch(/searchParams\.get\('iss'\)/)
    expect(service).toMatch(/授权回调的签发方与授权服务器不一致/)
  })

  it('token 响应带 iss 时校验，refresh 与 authorization_code 都传 issuer', () => {
    expect(service).toMatch(/令牌响应的签发方与授权服务器不一致/)
    expect((service.match(/postToken\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
  })

  it('DCR 注册体声明 application_type=native', () => {
    expect(service).toMatch(/application_type: 'native'/)
  })

  it('HTTP 请求带 MCP-Protocol-Version 头', () => {
    expect(http).toMatch(/headers\['MCP-Protocol-Version'\] = PROTOCOL_VERSION_HEADER_VALUE/)
  })
})

describe('技能目录包签名验签', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const manifest: SkillDirManifest = {
    format: 'pocketai-skill-dir',
    version: 1,
    entry: 'SKILL.md',
    files: [{ path: 'SKILL.md', hash: 'sha256:' + 'a'.repeat(64) }]
  }
  const unsigned = { ...manifest }

  const signedManifest = (): string => {
    const sig = sign(null, Buffer.from(canonicalJson(unsigned), 'utf8'), privateKey).toString('base64url')
    return JSON.stringify({ ...unsigned, signature: sig })
  }

  it('未签名的清单放行，标记 signed=false', () => {
    const r = verifySkillDirManifestSignature(JSON.stringify(unsigned), manifest, pubPem)
    expect(r.signed).toBe(false)
    expect(r.verified).toBe(false)
    expect(r.error).toBeUndefined()
  })

  it('签名正确 + 公钥匹配 ⇒ verified=true', () => {
    const r = verifySkillDirManifestSignature(signedManifest(), manifest, pubPem)
    expect(r.signed).toBe(true)
    expect(r.verified).toBe(true)
    expect(r.error).toBeUndefined()
  })

  it('清单被篡改（hash 改了）⇒ 验签失败', () => {
    const text = signedManifest()
    const tampered = text.replace('a'.repeat(64), 'b'.repeat(64))
    const r = verifySkillDirManifestSignature(tampered, { ...manifest, files: [{ path: 'SKILL.md' }] }, pubPem)
    expect(r.verified).toBe(false)
    expect(r.error).toMatch(/签名校验失败/)
  })

  it('带签名但索引没给公钥 ⇒ 拒绝安装', () => {
    const r = verifySkillDirManifestSignature(signedManifest(), manifest, undefined)
    expect(r.error).toMatch(/索引未提供发布者公钥/)
  })

  it('错误的公钥 ⇒ 验签失败', () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const r = verifySkillDirManifestSignature(signedManifest(), manifest, other)
    expect(r.error).toMatch(/签名校验失败/)
  })

  it('签名格式非法 ⇒ 拒绝', () => {
    const r = verifySkillDirManifestSignature(JSON.stringify({ ...unsigned, signature: 'bad' }), manifest, pubPem)
    expect(r.error).toMatch(/签名格式不正确/)
  })
})
