// 增量同步检测测试：classifyFileDoc 纯函数分类 + hashFile 真实文件
// （sync-check 顶层 import kbDocRepo → database → portable 需要 electron mock）
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => process.cwd() }
}))
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyFileDoc, hashFile } from '../src/main/knowledge/sync-check'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('classifyFileDoc — 文档变更分类', () => {
  it('hash 一致 → unchanged', () => {
    expect(classifyFileDoc('aaa', 'aaa')).toBe('unchanged')
  })

  it('hash 不同 → changed', () => {
    expect(classifyFileDoc('aaa', 'bbb')).toBe('changed')
  })

  it('磁盘读不到（null）→ missing', () => {
    expect(classifyFileDoc('aaa', null)).toBe('missing')
  })
})

describe('hashFile — 内容 sha256', () => {
  it('同内容同 hash，内容变化 hash 变化', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-sync-'))
    tmpDirs.push(dir)
    const file = path.join(dir, 'doc.md')
    fs.writeFileSync(file, '# hello')
    const h1 = await hashFile(file)

    fs.writeFileSync(file, '# hello world')
    const h2 = await hashFile(file)

    expect(h1).toMatch(/^[0-9a-f]{64}$/)
    expect(h2).toMatch(/^[0-9a-f]{64}$/)
    expect(h1).not.toBe(h2)

    // 相同内容再写一次，hash 恢复一致
    fs.writeFileSync(file, '# hello')
    expect(await hashFile(file)).toBe(h1)
  })

  it('文件不存在时 reject', async () => {
    await expect(hashFile(path.join(os.tmpdir(), 'pocketai-sync-not-exist-xyz.md'))).rejects.toThrow()
  })
})
