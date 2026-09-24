// files-service 路径安全与文件名清洗测试
//
// 覆盖 src/main/files/files-service.ts 的核心安全边界：
// - sanitizeName：文件名/文件夹名清洗，禁止路径分隔符与特殊字符
// - toAbs：相对路径 → DATA_DIR 内绝对路径，拒绝穿越（.. / NUL / 越界）
//
// 策略：
// - sanitizeName 是纯函数，直接 import 断言
// - toAbs 依赖 DATA_DIR，vi.mock portable 模块固定测试路径
import { describe, it, expect, vi } from 'vitest'
import path from 'node:path'

// 固定 DATA_DIR 用于路径边界断言（vi.hoisted 确保 mock factory 可见）
const { MOCK_DATA_DIR } = vi.hoisted(() => {
  // 不能在此引用外部 path（hoisting 顺序），直接写平台相关路径
  const sep = process.platform === 'win32' ? '\\' : '/'
  return { MOCK_DATA_DIR: ['C:', 'pocketai-test-data'].join(sep) }
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: MOCK_DATA_DIR
}))

import { sanitizeName, toAbs } from '../src/main/files/files-service'

describe('sanitizeName — 文件名/文件夹名清洗', () => {
  it('正常文件名原样返回（去除首尾空白）', () => {
    expect(sanitizeName('note.txt')).toBe('note.txt')
    expect(sanitizeName('  note.txt  ')).toBe('note.txt')
    expect(sanitizeName('我的笔记.md')).toBe('我的笔记.md')
  })

  it('空串 / 纯空白 → 抛「非法文件名」', () => {
    expect(() => sanitizeName('')).toThrow('非法文件名')
    expect(() => sanitizeName('   ')).toThrow('非法文件名')
  })

  it('相对路径标记 . / .. → 抛「非法文件名」', () => {
    expect(() => sanitizeName('.')).toThrow('非法文件名')
    expect(() => sanitizeName('..')).toThrow('非法文件名')
  })

  it('路径分隔符 \\ / → 抛「非法文件名」', () => {
    expect(() => sanitizeName('foo\\bar')).toThrow('非法文件名')
    expect(() => sanitizeName('foo/bar')).toThrow('非法文件名')
  })

  it('Windows 保留字符 : * ? " < > | → 抛「非法文件名」', () => {
    expect(() => sanitizeName('a:b')).toThrow('非法文件名')
    expect(() => sanitizeName('a*b')).toThrow('非法文件名')
    expect(() => sanitizeName('a?b')).toThrow('非法文件名')
    expect(() => sanitizeName('a"b')).toThrow('非法文件名')
    expect(() => sanitizeName('a<b')).toThrow('非法文件名')
    expect(() => sanitizeName('a>b')).toThrow('非法文件名')
    expect(() => sanitizeName('a|b')).toThrow('非法文件名')
  })

  it('NUL 字符 → 抛「非法文件名」', () => {
    expect(() => sanitizeName('foo\0bar')).toThrow('非法文件名')
  })

  it('含点的正常文件名（如 .gitignore、archive.tar.gz）合法', () => {
    expect(sanitizeName('.gitignore')).toBe('.gitignore')
    expect(sanitizeName('archive.tar.gz')).toBe('archive.tar.gz')
  })
})

describe('toAbs — 相对路径安全解析', () => {
  it('空串 → DATA_DIR 本身', () => {
    expect(toAbs('')).toBe(MOCK_DATA_DIR)
  })

  it('单层相对路径 → DATA_DIR 下', () => {
    expect(toAbs('foo')).toBe(path.join(MOCK_DATA_DIR, 'foo'))
    expect(toAbs('foo/bar')).toBe(path.join(MOCK_DATA_DIR, 'foo', 'bar'))
  })

  it('反斜杠分隔符自动转为正斜杠', () => {
    expect(toAbs('foo\\bar')).toBe(path.join(MOCK_DATA_DIR, 'foo', 'bar'))
  })

  it('首尾多余斜杠被去除', () => {
    expect(toAbs('/foo/')).toBe(path.join(MOCK_DATA_DIR, 'foo'))
    expect(toAbs('//foo//bar//')).toBe(path.join(MOCK_DATA_DIR, 'foo', 'bar'))
  })

  it('.. 顶层穿越 → 抛「非法路径」', () => {
    expect(() => toAbs('..')).toThrow('非法路径')
    expect(() => toAbs('../foo')).toThrow('非法路径')
    expect(() => toAbs('../')).toThrow('非法路径')
  })

  it('深层 .. 解析后越界 → 抛「非法路径」', () => {
    // foo/../../bar → posix.normalize → ../bar → 以 ../ 开头被拒
    expect(() => toAbs('foo/../../bar')).toThrow('非法路径')
    expect(() => toAbs('a/b/../../../c')).toThrow('非法路径')
  })

  it('刚好回到 DATA_DIR（foo/..）合法', () => {
    // foo/.. → posix.normalize → ''（空）→ 等于 DATA_DIR
    expect(toAbs('foo/..')).toBe(MOCK_DATA_DIR)
  })

  it('DATA_DIR 内的 .. 合法（foo/../bar）', () => {
    // foo/../bar → posix.normalize → bar
    expect(toAbs('foo/../bar')).toBe(path.join(MOCK_DATA_DIR, 'bar'))
  })

  it('NUL 注入 → 抛「非法路径」', () => {
    expect(() => toAbs('foo\0bar')).toThrow('非法路径')
  })

  it('绝对路径被 normalize 后越界 → 抛错', () => {
    // 传入绝对路径（如 C:/Windows），posix.normalize 保留，拼接后越界
    expect(() => toAbs('C:/Windows')).toThrow()
  })
})
