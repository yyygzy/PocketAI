// P2-1：本地备份清单与版本比较（首页「最近一次备份」「便携版有没有新版本」的判断底座）
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listLocalBackups } from '../src/main/backup/local-backups'
import { compareVersionStrings } from '../src/shared/version'

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-backups-'))
}

describe('listLocalBackups：只认自己的备份包，最新在前', () => {
  it('目录不存在 ⇒ []（真没备份过，不是读失败）', () => {
    const dir = path.join(mkTmp(), 'nope')
    expect(listLocalBackups(dir)).toEqual([])
  })

  it('只收 pocketai-backup-*.zip，加密包标 encrypted，按 mtime 倒序', () => {
    const dir = mkTmp()
    const plain = path.join(dir, 'pocketai-backup-20260101-000000.zip')
    const enc = path.join(dir, 'pocketai-backup-20260102-000000.enc.zip')
    fs.writeFileSync(plain, 'x')
    fs.writeFileSync(enc, 'xx')
    // 其他 zip / 文本不许混进来（用户自己丢进去的文件不是我们的备份）
    fs.writeFileSync(path.join(dir, 'notes.zip'), 'x')
    fs.writeFileSync(path.join(dir, 'pocketai-backup-20260103.txt'), 'x')
    // 明确拉开 mtime，避免依赖创建顺序
    fs.utimesSync(plain, new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'))
    fs.utimesSync(enc, new Date('2026-01-02T00:00:00Z'), new Date('2026-01-02T00:00:00Z'))

    const list = listLocalBackups(dir)
    expect(list.map((b) => b.name)).toEqual([
      'pocketai-backup-20260102-000000.enc.zip',
      'pocketai-backup-20260101-000000.zip'
    ])
    expect(list[0]!.encrypted).toBe(true)
    expect(list[1]!.encrypted).toBe(false)
    expect(list[1]!.size).toBe(1)
    expect(Number.isFinite(list[0]!.mtime)).toBe(true)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('compareVersionStrings：数字段比较，够用的那条口径', () => {
  it('逐段按数值比，而不是字典序', () => {
    expect(compareVersionStrings('1.10.0', '1.9.9')).toBe(1)
    expect(compareVersionStrings('1.9.9', '1.10.0')).toBe(-1)
    expect(compareVersionStrings('2.0.0', '2.0')).toBe(0)
    expect(compareVersionStrings('1.0.1', '1.0.1')).toBe(0)
  })

  it('容忍 v 前缀与预发布后缀', () => {
    expect(compareVersionStrings('v1.2.0', '1.1.9')).toBe(1)
    expect(compareVersionStrings('1.2.0-beta.1', '1.2.0')).toBe(0)
  })
})
