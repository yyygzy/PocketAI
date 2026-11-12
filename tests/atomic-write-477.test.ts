// 原子写 + 失败归一（§477）
//
// 钉住三件事：
//  1) 成功写不留 `.pocketai-tmp` 残留；
//  2) 失败不破坏目标位置的**原有内容**（这是"半份文件"问题的核心）；
//  3) 常见 errno 都翻成人话，但保留原始信息（不吞错）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describeWriteFailure, writeFileAtomicSync } from '../src/main/files/atomic-write'

let dir = ''

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pai-atomic-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomicSync', () => {
  it('成功：写入目标、覆盖旧内容、不留临时文件', () => {
    const target = path.join(dir, 'report.md')
    fs.writeFileSync(target, '旧内容')

    writeFileAtomicSync(target, '新内容')

    expect(fs.readFileSync(target, 'utf8')).toBe('新内容')
    expect(fs.readdirSync(dir)).toEqual(['report.md'])
  })

  it('失败（目标目录不存在）：报可读原因，且不创建任何文件', () => {
    const target = path.join(dir, 'no-such-dir', 'x.md')
    expect(() => writeFileAtomicSync(target, 'x')).toThrow(/目标目录不存在/)
    expect(fs.readdirSync(dir)).toEqual([])
  })

  it('失败（rename 目标被目录占用）：原有内容不受影响，临时文件被清掉', () => {
    const target = path.join(dir, 'busy-target')
    fs.mkdirSync(target)
    fs.writeFileSync(path.join(target, 'keep.txt'), '原始数据')

    // 目标被同名目录占住 → rename 失败；错误已被归一且点名了目标
    expect(() => writeFileAtomicSync(target, 'x')).toThrow(/busy-target/)

    // 原目录与其中的数据必须完好，临时文件不能留下
    expect(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8')).toBe('原始数据')
    expect(fs.readdirSync(dir).sort()).toEqual(['busy-target'])
  })

  it('mode 透传：恢复密钥这类文件要 0600', () => {
    const target = path.join(dir, 'key.txt')
    writeFileAtomicSync(target, 'secret', { mode: 0o600 })
    if (process.platform !== 'win32') {
      expect(fs.statSync(target).mode & 0o777).toBe(0o600)
    }
    expect(fs.readFileSync(target, 'utf8')).toBe('secret')
  })
})

describe('describeWriteFailure', () => {
  const err = (code: string): NodeJS.ErrnoException => Object.assign(new Error('raw'), { code })

  it('常见 errno 翻成同一种人话', () => {
    expect(describeWriteFailure(err('ENOSPC'), '/a/b.md')).toContain('磁盘空间不足')
    expect(describeWriteFailure(err('EACCES'), '/a/b.md')).toContain('没有权限写入')
    expect(describeWriteFailure(err('EPERM'), '/a/b.md')).toContain('没有权限写入')
    expect(describeWriteFailure(err('EROFS'), '/a/b.md')).toContain('只读')
    expect(describeWriteFailure(err('EBUSY'), '/a/b.md')).toContain('被其他程序占用')
    expect(describeWriteFailure(err('ENOENT'), '/a/b.md')).toContain('目标目录不存在')
    expect(describeWriteFailure(err('ENAMETOOLONG'), '/a/b.md')).toContain('路径过长')
  })

  it('都带文件名，且未知码保留原始信息（不吞错误）', () => {
    expect(describeWriteFailure(err('ENOSPC'), '/a/b.md')).toContain('b.md')
    expect(describeWriteFailure(err('EWEIRD'), '/a/b.md')).toContain('写入')
    expect(describeWriteFailure(err('EWEIRD'), '/a/b.md')).toContain('raw')
  })
})
