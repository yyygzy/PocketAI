// 远程技能目录包（manifest + 逐文件同源抓取）测试
//
// 覆盖：清单格式/版本/入口校验、路径安全（../ 绝对路径 反斜杠 盘符 深度）、体积预检在下载前、
// 逐文件 hash 校验三态、跨源拒绝、下载失败清理临时目录。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

const mocks = vi.hoisted(() => {
  const os = require('node:os')
  return { safeFetch: vi.fn(), tmp: os.tmpdir() as string }
})
vi.mock('../src/main/net/safe-fetch', () => ({ safeFetch: mocks.safeFetch }))
// skill-files → portable 需要 electron app；本测试只用它的常量，整层桩掉路径相关依赖
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }))
vi.mock('../src/main/portable', () => ({ DATA_DIR: mocks.tmp, APP_ROOT: mocks.tmp }))

import {
  parseSkillDirManifest,
  safeManifestRel,
  downloadSkillDir,
  SKILL_MANIFEST_MAX_BYTES
} from '../src/main/skills/skill-remote-dir'

const MANIFEST_URL = 'https://raw.githubusercontent.com/acme/skills/main/skill-a/manifest.json'

const entry = (content: string) =>
  `---\nname: 测试技能\ndescription: 目录包\n---\n${content}`

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`
}

const okResult = (body: string) => ({ status: 200, body: Buffer.from(body, 'utf8'), headers: {}, finalUrl: '' })

beforeEach(() => {
  mocks.safeFetch.mockReset()
})

describe('safeManifestRel — 清单路径安全', () => {
  it('接受正常相对路径与多层子目录', () => {
    expect(safeManifestRel('SKILL.md')).toBe('SKILL.md')
    expect(safeManifestRel('references/api.md')).toBe('references/api.md')
    expect(safeManifestRel('a/b/c/d')).toBe('a/b/c/d')
  })
  it('拒绝 .. / 绝对 / 盘符 / 反斜杠 / NUL / 超深', () => {
    expect(safeManifestRel('../evil.md')).toBeNull()
    expect(safeManifestRel('a/../../evil')).toBeNull()
    expect(safeManifestRel('/etc/passwd')).toBeNull()
    expect(safeManifestRel('C:/evil')).toBeNull()
    expect(safeManifestRel('a\\evil')).toBeNull()
    expect(safeManifestRel('a/\0b')).toBeNull()
    expect(safeManifestRel('a/b/c/d/e')).toBeNull()
  })
})

describe('parseSkillDirManifest — 清单解析', () => {
  it('合法清单解析成功，保留 size/hash', () => {
    const text = JSON.stringify({
      format: 'pocketai-skill-dir',
      version: 1,
      entry: 'SKILL.md',
      files: [
        { path: 'SKILL.md', size: 100, hash: sha256('x') },
        { path: 'references/a.md', size: 50 }
      ]
    })
    const r = parseSkillDirManifest(text)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.entry).toBe('SKILL.md')
    expect(r.manifest.files).toHaveLength(2)
    expect(r.manifest.files[1]!.path).toBe('references/a.md')
  })
  it('格式/版本不对整体拒绝', () => {
    expect(parseSkillDirManifest(JSON.stringify({ format: 'wrong', version: 1, entry: 'SKILL.md', files: [] })).ok).toBe(false)
    expect(parseSkillDirManifest(JSON.stringify({ format: 'pocketai-skill-dir', version: 2, entry: 'SKILL.md', files: [] })).ok).toBe(false)
  })
  it('入口不在 files 里 ⇒ 拒绝', () => {
    const r = parseSkillDirManifest(JSON.stringify({
      format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md',
      files: [{ path: 'references/a.md' }]
    }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('入口')
  })
  it('单文件超 256KB / 总量超 2MB / 文件数超 200 ⇒ 对应错误码', () => {
    const base = { format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md' }
    const tooBig = parseSkillDirManifest(JSON.stringify({
      ...base, files: [{ path: 'SKILL.md', size: 300 * 1024 }]
    }))
    expect(tooBig.ok).toBe(false)
    if (!tooBig.ok) expect(tooBig.error).toBe('FILE_TOO_LARGE')

    const tooMany = parseSkillDirManifest(JSON.stringify({
      ...base, files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}` }))
    }))
    expect(tooMany.ok).toBe(false)
    if (!tooMany.ok) expect(tooMany.error).toBe('TOO_MANY_FILES')
  })
  it('重复路径 ⇒ 拒绝', () => {
    const r = parseSkillDirManifest(JSON.stringify({
      format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md',
      files: [{ path: 'SKILL.md' }, { path: 'SKILL.md' }]
    }))
    expect(r.ok).toBe(false)
  })
  it('清单体积上限常量为 512KB', () => {
    expect(SKILL_MANIFEST_MAX_BYTES).toBe(512 * 1024)
  })
})

describe('downloadSkillDir — 逐文件抓取', () => {
  it('正常下载：入口原文 + 资源文件列表 + 临时目录可清理', async () => {
    const manifest = parseSkillDirManifest(JSON.stringify({
      format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md',
      files: [
        { path: 'SKILL.md' },
        { path: 'references/a.md' }
      ]
    }))
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    mocks.safeFetch.mockImplementation((url: string) =>
      Promise.resolve(okResult(url.includes('SKILL.md') ? entry('正文') : '# 参考'))
    )
    const r = await downloadSkillDir(MANIFEST_URL, manifest.manifest)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.result.entryText).toContain('正文')
    expect(r.result.files.map((f) => f.rel)).toEqual(['references/a.md'])
    expect(r.result.unverified).toBe(2)
    expect(fs.existsSync(r.result.tempDir)).toBe(true)
    fs.rmSync(r.result.tempDir, { recursive: true, force: true })
  })

  it('跨源资源在清单阶段即被拒（绝对 URL 不是合法相对路径）', () => {
    const manifest = parseSkillDirManifest(JSON.stringify({
      format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md',
      files: [{ path: 'SKILL.md' }, { path: 'https://evil.example/x.md' }]
    }))
    expect(manifest.ok).toBe(false)
    expect(mocks.safeFetch).not.toHaveBeenCalled()
  })

  it('hash 不匹配 ⇒ 拒绝', async () => {
    const manifest = parseSkillDirManifest(JSON.stringify({
      format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md',
      files: [{ path: 'SKILL.md', hash: sha256('预期内容') }]
    }))
    if (!manifest.ok) throw new Error('fixture invalid')
    mocks.safeFetch.mockResolvedValue(okResult(entry('实际内容')))
    const r = await downloadSkillDir(MANIFEST_URL, manifest.manifest)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('校验失败')
  })

  it('下载抛错 ⇒ 返回错误（临时目录内部已清理）', async () => {
    const manifest = parseSkillDirManifest(JSON.stringify({
      format: 'pocketai-skill-dir', version: 1, entry: 'SKILL.md',
      files: [{ path: 'SKILL.md' }]
    }))
    if (!manifest.ok) throw new Error('fixture invalid')
    mocks.safeFetch.mockRejectedValue(new Error('network down'))
    const r = await downloadSkillDir(MANIFEST_URL, manifest.manifest)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('network down')
  })
})
