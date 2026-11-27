// @vitest-environment node
// P1-3d：内容指纹纯模块。证明"比的是内容，不是 mtime/size"，且降级绝不冒充 unchanged。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createWorkspaceFingerprint,
  compareWorkspaceFingerprint,
  parseWorkspaceFingerprint
} from '../src/main/agent/resume-workspace-fingerprint'
import { CHANGE_SET_LIMITS } from '../src/main/agent/workspace-changes'

let root = ''
const seed = (rel: string, content: string): void => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content)
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'p13d-fp-'))
  seed('a.txt', 'v1')
  seed('sub/b.txt', 'keep')
  seed('node_modules/dep.txt', 'not-counted')
  seed('.git/config', 'not-counted')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('续跑内容指纹', () => {
  it('只收受控文件，内容与大小入指纹；node_modules/.git 不算', () => {
    const fp = createWorkspaceFingerprint(root)
    expect(fp?.status).toBe('ok')
    if (!fp || fp.status !== 'ok') return
    expect(Object.keys(fp.files).sort()).toEqual(['a.txt', 'sub/b.txt'])
    expect(fp.files['a.txt']?.size).toBe(2)
    expect(fp.files['a.txt']?.sha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('内容变了就 changed；只有 mtime 变了仍 unchanged', () => {
    const raw = JSON.stringify(createWorkspaceFingerprint(root))
    const a = path.join(root, 'a.txt')
    const before = fs.statSync(a)
    fs.utimesSync(a, new Date(before.mtimeMs + 10_000), new Date(before.mtimeMs + 10_000))
    expect(compareWorkspaceFingerprint(raw, root)).toBe('unchanged')

    seed('a.txt', 'v2')
    expect(compareWorkspaceFingerprint(raw, root)).toBe('changed')
  })

  it('删文件、加文件都算 changed', () => {
    const raw = JSON.stringify(createWorkspaceFingerprint(root))
    fs.unlinkSync(path.join(root, 'sub/b.txt'))
    expect(compareWorkspaceFingerprint(raw, root)).toBe('changed')

    const raw2 = JSON.stringify(createWorkspaceFingerprint(root))
    seed('new.txt', 'new')
    expect(compareWorkspaceFingerprint(raw2, root)).toBe('changed')
  })

  it('坏 JSON / 坏哈希 / degraded / 当前扫不全 ⇒ unavailable，绝不放宽', () => {
    const good = JSON.stringify(createWorkspaceFingerprint(root))
    expect(parseWorkspaceFingerprint('{nope')).toBeNull()
    expect(compareWorkspaceFingerprint('{nope', root)).toBe('unavailable')
    const badHash = JSON.parse(good) as { files: Record<string, { sha256: string }> }
    badHash.files['a.txt']!.sha256 = 'z'.repeat(64)
    expect(compareWorkspaceFingerprint(JSON.stringify(badHash), root)).toBe('unavailable')

    const degraded = JSON.stringify({
      v: 1, status: 'degraded', root, reason: 'timeout', files: {}
    })
    expect(compareWorkspaceFingerprint(degraded, root)).toBe('unavailable')

    const tiny = { ...CHANGE_SET_LIMITS, maxScanFiles: 1 }
    expect(compareWorkspaceFingerprint(good, root, tiny)).toBe('unavailable')
  })

  it('空 root / 文件不是目录 ⇒ degraded', () => {
    expect(createWorkspaceFingerprint('')).toBeNull()
    const fp = createWorkspaceFingerprint(path.join(root, 'a.txt'))
    expect(fp?.status).toBe('degraded')
    if (fp && fp.status === 'degraded') expect(fp.reason).toBe('bad-root')
  })
})
