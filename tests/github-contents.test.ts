// GitHub Contents API 适配纯函数测试：地址映射 / Accept / 错误文案 / hash 三态
import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  GITHUB_NOT_FOUND_TEXT,
  GITHUB_RATE_LIMIT_TEXT,
  GITHUB_RAW_ACCEPT,
  githubHttpErrorText,
  githubIndexCandidates,
  githubNetworkErrorText,
  githubRequestHeaders,
  githubSkillCandidates,
  toContentsApiUrl,
  toRawGithubUrl,
  verifyContentHash
} from '../src/main/skills/github-contents'

const RAW_SKILL =
  'https://raw.githubusercontent.com/yyygzy/skill-registry/main/skill-code-review.json'
const API_SKILL =
  'https://api.github.com/repos/yyygzy/skill-registry/contents/skill-code-review.json?ref=main'
const API_INDEX =
  'https://api.github.com/repos/yyygzy/skill-registry/contents/index.json?ref=main'
const RAW_INDEX = 'https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json'

describe('地址映射', () => {
  it('raw 技能地址映射为 Contents API', () => {
    expect(toContentsApiUrl(RAW_SKILL)).toBe(API_SKILL)
  })

  it('Contents API 地址反向映射回 raw', () => {
    expect(toRawGithubUrl(API_INDEX)).toBe(RAW_INDEX)
  })

  it('嵌套路径保留原层级', () => {
    expect(
      toContentsApiUrl(
        'https://raw.githubusercontent.com/yyygzy/skill-registry/main/skills/foo/SKILL.md'
      )
    ).toBe(
      'https://api.github.com/repos/yyygzy/skill-registry/contents/skills/foo/SKILL.md?ref=main'
    )
  })

  it('非 GitHub URL 不改写', () => {
    expect(toContentsApiUrl('https://example.com/index.json')).toBeNull()
    expect(toRawGithubUrl('https://example.com/repos/a/b/contents/c?ref=main')).toBeNull()
    expect(githubIndexCandidates('https://example.com/index.json')).toEqual([
      'https://example.com/index.json'
    ])
    expect(githubSkillCandidates('https://example.com/skill.json')).toEqual({
      primaryUrl: 'https://example.com/skill.json',
      fallbackUrl: null
    })
  })

  it('索引候选：API 优先、raw 兜底（raw 输入与 API 输入都一样）', () => {
    expect(githubIndexCandidates(RAW_INDEX)).toEqual([API_INDEX, RAW_INDEX])
    expect(githubIndexCandidates(API_INDEX)).toEqual([API_INDEX, RAW_INDEX])
  })

  it('技能候选：raw 输入映射为 API + raw 兜底', () => {
    expect(githubSkillCandidates(RAW_SKILL)).toEqual({
      primaryUrl: API_SKILL,
      fallbackUrl: RAW_SKILL
    })
  })

  it('GitHub 域名附带 raw Accept，其它域名不带', () => {
    expect(githubRequestHeaders(API_SKILL)).toEqual({ Accept: GITHUB_RAW_ACCEPT })
    expect(githubRequestHeaders(RAW_SKILL)).toEqual({ Accept: GITHUB_RAW_ACCEPT })
    expect(githubRequestHeaders('https://example.com/skill.json')).toBeUndefined()
  })
})

describe('错误文案', () => {
  it('403 / 429 说限流', () => {
    expect(githubHttpErrorText(403)).toBe(GITHUB_RATE_LIMIT_TEXT)
    expect(githubHttpErrorText(429)).toBe(GITHUB_RATE_LIMIT_TEXT)
  })

  it('404 说地址或内容不存在', () => {
    expect(githubHttpErrorText(404)).toBe(GITHUB_NOT_FOUND_TEXT)
  })

  it('其它状态不甩裸错误码', () => {
    expect(githubHttpErrorText(500)).not.toBe('HTTP 500')
    expect(githubHttpErrorText(500)).toContain('HTTP 500')
  })

  it('连接重置说该网络可能屏蔽 raw', () => {
    const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    expect(githubNetworkErrorText(reset)).toContain('屏蔽了 raw.githubusercontent.com')
  })

  it('普通错误保留原文', () => {
    expect(githubNetworkErrorText(new Error('some failure'))).toBe('some failure')
  })
})

describe('hash 校验三态', () => {
  const body = Buffer.from('abc', 'utf8')
  const sha256 = createHash('sha256').update(body).digest('hex')
  const md5 = createHash('md5').update(body).digest('hex')

  it('没有 hash 时放行', () => {
    expect(verifyContentHash(body, undefined)).toEqual({ state: 'absent' })
    expect(verifyContentHash(body, '')).toEqual({ state: 'absent' })
    expect(verifyContentHash(body, '   ')).toEqual({ state: 'absent' })
  })

  it('sha256 / md5 匹配时通过（含前缀与大小写）', () => {
    expect(verifyContentHash(body, sha256)).toEqual({ state: 'matched' })
    expect(verifyContentHash(body, sha256.toUpperCase())).toEqual({ state: 'matched' })
    expect(verifyContentHash(body, `sha256:${sha256}`)).toEqual({ state: 'matched' })
    expect(verifyContentHash(body, md5)).toEqual({ state: 'matched' })
    expect(verifyContentHash(body, `md5:${md5}`)).toEqual({ state: 'matched' })
  })

  it('不匹配时拒绝', () => {
    expect(verifyContentHash(body, '0'.repeat(64))).toEqual({
      state: 'mismatch',
      error: '技能内容校验失败（hash 不匹配）'
    })
  })

  it('格式不支持时拒绝，不放行', () => {
    expect(verifyContentHash(body, 'not-a-hash')).toEqual({
      state: 'mismatch',
      error: '技能 hash 格式不正确，已拒绝导入'
    })
  })
})
