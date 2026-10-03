// 导出拖拽临时文件管理测试（路径归属校验 / 写入 / 过期清理）
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isDragTempPath, writeDragTempFile, cleanupDragTempDir, DRAG_TEMP_MAX_AGE_MS } from '../src/main/export/drag-temp'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-drag-test-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('isDragTempPath 路径归属校验', () => {
  it('目录内一级子文件 → true', () => {
    expect(isDragTempPath(path.join(dir, 'a.md'), dir)).toBe(true)
  })

  it('目录外 / 嵌套子目录 / 目录穿越 → false', () => {
    expect(isDragTempPath(path.join(dir, '..', 'b.md'), dir)).toBe(false)
    expect(isDragTempPath(path.join(dir, 'sub', 'c.md'), dir)).toBe(false)
    expect(isDragTempPath('C:\\Windows\\System32\\x.md', dir)).toBe(false)
  })

  it('空串/非法输入 → false', () => {
    expect(isDragTempPath('', dir)).toBe(false)
  })
})

describe('writeDragTempFile', () => {
  it('写入 md（utf8）并返回目录内路径；文件名安全化', () => {
    const p = writeDragTempFile('会话: 1/2', 'md', '# 你好', Date.now(), dir)
    expect(isDragTempPath(p, dir)).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('# 你好')
    expect(path.basename(p)).toMatch(/^会话_ 1_2-\d+-[a-z0-9]{6}\.md$/)
  })

  it('写入 png（base64）', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    const p = writeDragTempFile('img', 'png', png, Date.now(), dir)
    expect(fs.readFileSync(p)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('空内容 / 超上限抛错', () => {
    expect(() => writeDragTempFile('x', 'md', '', Date.now(), dir)).toThrow()
  })
})

describe('cleanupDragTempDir', () => {
  it('清理 >24h 文件，保留新文件；目录不存在静默返回 0', () => {
    const oldP = path.join(dir, 'old.md')
    const newP = path.join(dir, 'new.md')
    fs.writeFileSync(oldP, 'old')
    fs.writeFileSync(newP, 'new')
    const now = Date.now()
    // 手工把 old 的 mtime 改到 25h 前
    const past = new Date(now - DRAG_TEMP_MAX_AGE_MS - 3600_000)
    fs.utimesSync(oldP, past, past)
    const removed = cleanupDragTempDir(now, dir)
    expect(removed).toBe(1)
    expect(fs.existsSync(oldP)).toBe(false)
    expect(fs.existsSync(newP)).toBe(true)
    expect(cleanupDragTempDir(now, path.join(dir, 'not-exist'))).toBe(0)
  })
})
