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
  it('目录内已存在的普通文件 → true', () => {
    const p = path.join(dir, 'a.md')
    fs.writeFileSync(p, 'x')
    expect(isDragTempPath(p, dir)).toBe(true)
  })

  it('文件不存在 → false（realpath 无法解析，不给未落盘的猜测路径放行）', () => {
    expect(isDragTempPath(path.join(dir, 'ghost.md'), dir)).toBe(false)
  })

  it('目录外 / 嵌套子目录 / 目录穿越 → false', () => {
    expect(isDragTempPath(path.join(dir, '..', 'b.md'), dir)).toBe(false)
    expect(isDragTempPath(path.join(dir, 'sub', 'c.md'), dir)).toBe(false)
    expect(isDragTempPath('C:\\Windows\\System32\\x.md', dir)).toBe(false)
  })

  it('空串/非法输入 → false', () => {
    expect(isDragTempPath('', dir)).toBe(false)
    expect(isDragTempPath(undefined as unknown as string, dir)).toBe(false)
    expect(isDragTempPath(42 as unknown as string, dir)).toBe(false)
  })

  it('目录内指向外部的符号链接 → false（SEC-15：只比 dirname 会被链接逃逸）', (ctx) => {
    const link = path.join(dir, 'escape.md')
    try {
      fs.symlinkSync(path.resolve(dir, '..', 'outside-secret.md'), link)
    } catch {
      ctx.skip() // Windows 无符号链接权限时跳过（POSIX 路径覆盖）
      return
    }
    try {
      expect(isDragTempPath(link, dir)).toBe(false)
    } finally {
      fs.rmSync(link, { force: true })
    }
  })
})

describe('writeDragTempFile', () => {
  it('写入 md（utf8）并返回目录内路径；文件名安全化', () => {
    const p = writeDragTempFile('会话: 1/2', 'md', '# 你好', Date.now(), dir)
    expect(isDragTempPath(p, dir)).toBe(true)
    expect(fs.readFileSync(p, 'utf8')).toBe('# 你好')
    expect(path.basename(p)).toMatch(/^会话_ 1_2-\d+-[a-z0-9]{6}\.md$/)
  })

  it('独占写：POSIX 下不开放 group/other 位，后缀为 6 位十六进制（SEC-15）', function () {
    const p = writeDragTempFile('secret', 'md', '内容', Date.now(), dir)
    const name = path.basename(p)
    expect(name).toMatch(/-[0-9a-f]{6}\.md$/)
    if (process.platform !== 'win32') {
      const mode = fs.statSync(p).mode & 0o077
      expect(mode).toBe(0)
    }
  })

  it('同名连续导出各自独立成文件，不覆盖前一份', () => {
    const now = Date.now()
    const a = writeDragTempFile('same', 'md', 'AAA', now, dir)
    const b = writeDragTempFile('same', 'md', 'BBB', now, dir)
    expect(a).not.toBe(b)
    expect(fs.readFileSync(a, 'utf8')).toBe('AAA')
    expect(fs.readFileSync(b, 'utf8')).toBe('BBB')
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
