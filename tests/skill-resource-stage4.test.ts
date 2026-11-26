// 阶段 4 真文件验收：references/assets 白名单只读、路径/软链/二进制/哈希四道闸。
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const TMP = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/'
  return base + sep + 'pocketai-skill-resource-500'
})

vi.mock('../src/main/portable', () => ({
  DATA_DIR: path.join(TMP, 'data'),
  DB_PATH: '',
  MCP_EXTENSIONS_DIR: '',
  isPortable: () => false,
  portableDataDir: () => TMP
}))

import {
  installSkillFiles,
  isReadableSkillResourcePath,
  listSkillFiles,
  readSkillFile,
  readSkillFolder,
  skillFilesDir
} from '../src/main/skills/skill-files'

const SRC = path.join(TMP, 'src')

function makeSource(): void {
  fs.mkdirSync(path.join(SRC, 'references'), { recursive: true })
  fs.mkdirSync(path.join(SRC, 'assets'), { recursive: true })
  fs.mkdirSync(path.join(SRC, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(SRC, 'SKILL.md'), '入口', 'utf8')
  fs.writeFileSync(path.join(SRC, 'references', 'api.md'), 'API 说明', 'utf8')
  fs.writeFileSync(path.join(SRC, 'assets', 'note.txt'), '资产说明', 'utf8')
  fs.writeFileSync(path.join(SRC, 'scripts', 'run.sh'), 'echo hi', 'utf8')
}

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  makeSource()
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('白名单', () => {
  it('纯路径函数只认 references/** 与 assets/** 下的文件', () => {
    expect(isReadableSkillResourcePath('references/api.md')).toBe(true)
    expect(isReadableSkillResourcePath('assets/deep/note.txt')).toBe(true)
    expect(isReadableSkillResourcePath('scripts/run.sh')).toBe(false)
    expect(isReadableSkillResourcePath('SKILL.md')).toBe(false)
    expect(isReadableSkillResourcePath('references')).toBe(false)
    expect(isReadableSkillResourcePath('references/../../secret.txt')).toBe(false)
    expect(() => isReadableSkillResourcePath('references/../../secret.txt')).not.toThrow()
  })

  it('清单只列可读文件；scripts 仍随包复制，但不给预览入口', () => {
    const read = readSkillFolder(SRC)
    const inst = installSkillFiles('s-4-list', read.files)
    expect(inst.copied).toContain('scripts/run.sh')
    expect(fs.existsSync(path.join(skillFilesDir('s-4-list'), 'scripts', 'run.sh'))).toBe(true)
    expect(listSkillFiles('s-4-list').map((f) => f.path).sort()).toEqual(['assets/note.txt', 'references/api.md'])
    expect(listSkillFiles('s-4-list').some((f) => f.path === '.skill-files.json')).toBe(false)
  })

  it('references/assets 真读得回，且带安装清单校验标记', () => {
    installSkillFiles('s-4-read', readSkillFolder(SRC).files)
    const ref = readSkillFile('s-4-read', 'references/api.md')
    expect(ref.content).toBe('API 说明')
    expect(ref.verified).toBe(true)
    expect(readSkillFile('s-4-read', 'assets/note.txt').content).toBe('资产说明')
    expect(() => readSkillFile('s-4-read', 'scripts/run.sh')).toThrow(/references\/ 或 assets\//)
  })
})

describe('路径攻击四道闸', () => {
  it('词法越界、绝对路径与 NUL 都拒', () => {
    installSkillFiles('s-4-attack', readSkillFolder(SRC).files)
    for (const bad of [
      '../../outside.txt',
      '/etc/passwd',
      'references/../../outside.txt',
      'references/api.md\0.txt'
    ]) {
      expect(() => readSkillFile('s-4-attack', bad)).toThrow()
    }
  })

  it('父目录软链指向外面 ⇒ realpath 复检拒读', () => {
    const outside = path.join(TMP, 'outside-4')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'api.md'), '外面的秘密', 'utf8')
    installSkillFiles('s-4-link', readSkillFolder(SRC).files)
    const dir = path.join(skillFilesDir('s-4-link'), 'references')
    try {
      fs.rmSync(dir, { recursive: true, force: true })
      fs.symlinkSync(outside, dir, 'junction')
    } catch {
      return // Windows 非开发者模式建不了软链，这条如实跳过
    }
    expect(() => readSkillFile('s-4-link', 'references/api.md')).toThrow(/越出技能目录|符号链接/)
  })

  it('二进制继续拒读（全缓冲区 NUL + 严格 UTF-8）', () => {
    installSkillFiles('s-4-bin', readSkillFolder(SRC).files)
    fs.writeFileSync(path.join(skillFilesDir('s-4-bin'), 'assets', 'bad.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    expect(() => readSkillFile('s-4-bin', 'assets/bad.bin')).toThrow(/二进制/)
  })

  it('安装后文件被改 ⇒ 枚举不到新 hash，按清单复验拒读', () => {
    installSkillFiles('s-4-hash', readSkillFolder(SRC).files)
    fs.writeFileSync(path.join(skillFilesDir('s-4-hash'), 'references', 'api.md'), '被改过的内容', 'utf8')
    expect(() => readSkillFile('s-4-hash', 'references/api.md')).toThrow(/资源校验失败/)
  })
})
