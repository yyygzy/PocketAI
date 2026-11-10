// skill-io 远程拉取的 GitHub Contents API 适配测试
//
// 覆盖：
// - 索引抓取：默认 API 地址 + Accept 头；API 失败后 raw 兜底；
// - 技能安装：raw → API 映射；API 404 回退 raw；
// - 错误文案：限流 / 不存在 / 连接重置；
// - hash 三态：匹配、缺失放行、不匹配拒绝。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'

const mocks = vi.hoisted(() => {
  const savedCalls: Array<Record<string, unknown>> = []
  return {
    savedCalls,
    safeFetch: vi.fn(),
    skillRepo: {
      save: (rec: Record<string, unknown>) => {
        savedCalls.push(rec)
        return { id: 'auto-uuid', isBuiltin: false, enabled: true, ...rec }
      },
      get: () => null,
      list: () => []
    }
  }
})

vi.mock('electron', () => ({
  dialog: { showSaveDialog: async () => ({}), showOpenDialog: async () => ({}) }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({ skillRepo: mocks.skillRepo }))
// 远程导入现在还会写审计；这一份用例只测拉取/映射，审计仓储整层桩掉
vi.mock('../src/main/db/repositories/skill-import-audit.repo', () => ({
  skillImportAuditRepo: { insert: () => true }
}))
vi.mock('../src/main/skills/skill-parser', () => ({
  parseSkillText: (text: string) => ({
    shape: { name: '远程技能', description: '', icon: '', content: text },
    error: ''
  })
}))
vi.mock('../src/main/skills/skill-files', () => ({
  readSkillFolder: () => ({ entryText: '', files: [], skipped: [] }),
  installSkillFiles: () => ({ entryText: '', copied: [], skipped: [], totalBytes: 0 }),
  rollbackSkillFiles: () => ''
}))
vi.mock('../src/main/net/safe-fetch', () => ({ safeFetch: mocks.safeFetch }))

import { fetchRegistryIndex, importSkillFromUrl } from '../src/main/skills/skill-io'
import {
  GITHUB_NOT_FOUND_TEXT,
  GITHUB_RATE_LIMIT_TEXT
} from '../src/main/skills/github-contents'

const API_INDEX =
  'https://api.github.com/repos/yyygzy/skill-registry/contents/index.json?ref=main'
const RAW_INDEX = 'https://raw.githubusercontent.com/yyygzy/skill-registry/main/index.json'
const RAW_SKILL =
  'https://raw.githubusercontent.com/yyygzy/skill-registry/main/skill-code-review.json'
const API_SKILL =
  'https://api.github.com/repos/yyygzy/skill-registry/contents/skill-code-review.json?ref=main'
const RAW_ACCEPT = 'application/vnd.github.raw+json'

function body(text: string, status = 200): { status: number; body: Buffer } {
  return { status, body: Buffer.from(text, 'utf8') }
}

function reset(): void {
  mocks.savedCalls.length = 0
  mocks.safeFetch.mockReset()
}

beforeEach(reset)

describe('fetchRegistryIndex — 索引抓取', () => {
  it('默认 API 地址抓取并附带 raw Accept', async () => {
    mocks.safeFetch.mockResolvedValue(body('{"skills":[]}'))
    const res = await fetchRegistryIndex(API_INDEX)
    expect(res).toEqual({ ok: true, text: '{"skills":[]}' })
    expect(mocks.safeFetch).toHaveBeenCalledTimes(1)
    expect(mocks.safeFetch.mock.calls[0]![0]).toBe(API_INDEX)
    expect(mocks.safeFetch.mock.calls[0]![1]).toMatchObject({
      headers: { Accept: RAW_ACCEPT }
    })
  })

  it('API 连接重置后回退 raw 再试一次', async () => {
    mocks.safeFetch
      .mockRejectedValueOnce(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce(body('{"skills":[]}'))
    const res = await fetchRegistryIndex(RAW_INDEX)
    expect(res.ok).toBe(true)
    expect(mocks.safeFetch.mock.calls.map((c) => c[0])).toEqual([API_INDEX, RAW_INDEX])
    expect(mocks.safeFetch.mock.calls[1]![1]).toMatchObject({
      headers: { Accept: RAW_ACCEPT }
    })
  })

  it('API 403 且 raw 也失败时优先报限流', async () => {
    mocks.safeFetch
      .mockResolvedValueOnce(body('', 403))
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
    const res = await fetchRegistryIndex(API_INDEX)
    expect(res).toEqual({ ok: false, error: GITHUB_RATE_LIMIT_TEXT })
  })

  it('两次都 404 时报地址或内容不存在', async () => {
    mocks.safeFetch.mockResolvedValue(body('', 404))
    const res = await fetchRegistryIndex(API_INDEX)
    expect(res).toEqual({ ok: false, error: GITHUB_NOT_FOUND_TEXT })
  })
})

describe('importSkillFromUrl — 技能安装', () => {
  it('raw 地址映射为 API 并附带 raw Accept', async () => {
    mocks.safeFetch.mockResolvedValue(body('远程技能内容'))
    const res = await importSkillFromUrl(RAW_SKILL)
    expect(res.ok).toBe(true)
    expect(mocks.safeFetch.mock.calls.map((c) => c[0])).toEqual([API_SKILL])
    expect(mocks.safeFetch.mock.calls[0]![1]).toMatchObject({
      headers: { Accept: RAW_ACCEPT }
    })
    expect(mocks.savedCalls[0]).toMatchObject({ content: '远程技能内容' })
  })

  it('API 404 后回退原 raw 地址再试一次', async () => {
    mocks.safeFetch
      .mockResolvedValueOnce(body('', 404))
      .mockResolvedValueOnce(body('远程技能内容'))
    const res = await importSkillFromUrl(RAW_SKILL)
    expect(res.ok).toBe(true)
    expect(mocks.safeFetch.mock.calls.map((c) => c[0])).toEqual([API_SKILL, RAW_SKILL])
  })

  it('非 GitHub URL 原样请求且不带 GitHub Accept', async () => {
    mocks.safeFetch.mockResolvedValue(body('远程技能内容'))
    const url = 'https://example.com/skill.json'
    const res = await importSkillFromUrl(url)
    expect(res.ok).toBe(true)
    expect(mocks.safeFetch.mock.calls[0]![0]).toBe(url)
    expect(mocks.safeFetch.mock.calls[0]![1]).not.toHaveProperty('headers')
  })

  it('连接重置时给出网络屏蔽提示', async () => {
    mocks.safeFetch.mockRejectedValue(
      Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })
    )
    const res = await importSkillFromUrl(RAW_SKILL)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('网络请求失败')
    expect(res.error).toContain('屏蔽了 raw.githubusercontent.com')
  })

  it('hash 不匹配时拒绝落库', async () => {
    mocks.safeFetch.mockResolvedValue(body('远程技能内容'))
    const res = await importSkillFromUrl(RAW_SKILL, '0'.repeat(64))
    expect(res).toEqual({ ok: false, error: '技能内容校验失败（hash 不匹配）' })
    expect(mocks.savedCalls).toHaveLength(0)
  })

  it('hash 匹配时通过', async () => {
    const text = '远程技能内容'
    const hash = createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
    mocks.safeFetch.mockResolvedValue(body(text))
    const res = await importSkillFromUrl(RAW_SKILL, hash)
    expect(res.ok).toBe(true)
    expect(mocks.savedCalls).toHaveLength(1)
  })

  it('清单没给 hash 时放行', async () => {
    mocks.safeFetch.mockResolvedValue(body('远程技能内容'))
    const res = await importSkillFromUrl(RAW_SKILL, '')
    expect(res.ok).toBe(true)
    expect(mocks.savedCalls).toHaveLength(1)
  })
})
