// @vitest-environment node
// §236 技能自带文件那一层：真 fs（临时目录），路径判据是纯函数，越界与符号链接都要有牙。
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// 走 mock portable 而不是 POCKETAI_APP_ROOT：portable.ts 在 import 期就调 app.getAppPath()，
// node 用例里没有 electron ⇒ 会当场炸（skill-io 那批同族坑）。这里只用到 DATA_DIR。
// 工厂里自己算路径：vi.mock 会被提到所有 import 之前，那时顶层的 `path`/常量还没初始化。
const TMP_DIR_NAME = 'pocketai-skill-files-236'
vi.mock('../src/main/portable', async () => {
  const os = await import('node:os')
  const p = await import('node:path')
  const tmp = p.join(os.tmpdir(), 'pocketai-skill-files-236')
  return {
    DATA_DIR: p.join(tmp, 'data'),
    DB_PATH: p.join(tmp, 'data', 'app.db'),
    MCP_EXTENSIONS_DIR: p.join(tmp, 'data', 'extensions'),
    isPortable: () => false,
    portableDataDir: () => tmp
  }
})

const os = await import('node:os')
const TMP = path.join(os.tmpdir(), TMP_DIR_NAME)

const {
  resolveSkillFilePath,
  readSkillFolder,
  installSkillFiles,
  listSkillFiles,
  readSkillFile,
  removeSkillFiles,
  skillFilesDir,
  skillFilesRoot,
  SKILL_FILE_READ_LIMIT_BYTES,
  SKILL_DIR_MAX_FILES
} = await import('../src/main/skills/skill-files')

const SRC = path.join(TMP, 'src-skill')

beforeAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(path.join(SRC, 'references'), { recursive: true })
  fs.mkdirSync(path.join(SRC, 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(SRC, 'SKILL.md'), '---\nname: 演示\n---\n\n正文在此\n', 'utf8')
  fs.writeFileSync(path.join(SRC, 'references', 'api.md'), 'API 说明', 'utf8')
  fs.writeFileSync(path.join(SRC, 'scripts', 'run.sh'), 'echo hi', 'utf8')
})

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true })
})

describe('路径判据（纯函数，不碰文件系统）', () => {
  it('目录内的相对路径放行，含子目录', () => {
    const abs = resolveSkillFilePath('abc-123', 'references/api.md')
    expect(abs.startsWith(skillFilesDir('abc-123'))).toBe(true)
    expect(abs.endsWith(path.join('references', 'api.md'))).toBe(true)
  })

  it.each([
    ['空串', ''],
    ['一个点', '.'],
    ['父目录', '..'],
    ['跳出目录', '../outside.md'],
    ['规范化后跳出', 'a/../../outside.md'],
    ['带 NUL', 'a\0b']
  ])('%s 一律拒（不把“越界”留给调用方去发现）', (_label, rel) => {
    expect(() => resolveSkillFilePath('abc-123', rel)).toThrow()
  })

  it('绝对路径不判"非法"，而是剥成根内的相对路径：保证出不去，不假装能猜用户的意图', () => {
    const abs = resolveSkillFilePath('abc-123', '/etc/passwd')
    expect(abs.startsWith(skillFilesDir('abc-123') + path.sep)).toBe(true)
  })
})

describe('读一份上游技能目录', () => {
  it('SKILL.md 进正文，references/scripts 进资源清单；入口文件本身不重复列进清单', () => {
    const r = readSkillFolder(SRC)
    expect(r.error).toBeUndefined()
    expect(r.entryText).toContain('正文在此')
    expect(r.files.map((f) => f.rel).sort()).toEqual(['references/api.md', 'scripts/run.sh'])
  })

  it('反向对照：没有 SKILL.md 的目录判 NO_SKILL_MD，不随便挑一个 .md 当正文', () => {
    const dir = path.join(TMP, 'no-entry')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README.md'), '这不是入口', 'utf8')
    expect(readSkillFolder(dir).error).toBe('NO_SKILL_MD')
  })

  it('选的不是目录 ⇒ NOT_A_DIRECTORY；不存在同样报出来，不演成"空目录"', () => {
    const file = path.join(SRC, 'SKILL.md')
    expect(readSkillFolder(file).error).toBe('NOT_A_DIRECTORY')
    expect(readSkillFolder(path.join(TMP, 'does-not-exist')).error).toBe('NOT_A_DIRECTORY')
  })
})

describe('装进 <DATA_DIR>/skills/<id>/ 再读回来', () => {
  const id = 's-236-install'

  it('装完列得出、读得回；路径由 id 推出（库里不用新加列）', () => {
    const r = readSkillFolder(SRC)
    const inst = installSkillFiles(id, r.files)
    expect(inst.copied.sort()).toEqual(['references/api.md', 'scripts/run.sh'])
    expect(listSkillFiles(id).map((f) => f.path).sort()).toEqual(['references/api.md', 'scripts/run.sh'])
    expect(readSkillFile(id, 'references/api.md').content).toBe('API 说明')
    expect(skillFilesDir(id).startsWith(skillFilesRoot())).toBe(true)
  })

  it('没装过技能的 id：列目录是空表，不是报错（"没有自带文件"是一种合法状态）', () => {
    expect(listSkillFiles('never-installed')).toEqual([])
  })

  it('读不存在的文件要报错，而不是回一个空串', () => {
    expect(() => readSkillFile(id, 'references/nope.md')).toThrow()
  })

  it('超单文件上限的那一份被跳过并给出原因，其余照样装进来（不是整批失败）', () => {
    const big = path.join(TMP, 'big-skill')
    fs.mkdirSync(big, { recursive: true })
    fs.writeFileSync(path.join(big, 'SKILL.md'), '入口', 'utf8')
    fs.mkdirSync(path.join(big, 'assets'), { recursive: true })
    fs.writeFileSync(path.join(big, 'assets', 'huge.bin'), 'x'.repeat(SKILL_FILE_READ_LIMIT_BYTES + 10), 'utf8')
    fs.writeFileSync(path.join(big, 'assets', 'small.txt'), '留得下', 'utf8')
    const r = readSkillFolder(big)
    const inst = installSkillFiles('s-236-big', r.files)
    expect(inst.skipped).toEqual([{ path: 'assets/huge.bin', reason: 'FILE_TOO_LARGE' }])
    expect(inst.copied).toEqual(['assets/small.txt'])
  })

  it('文件数超上限：多出来的被拒并带 TOO_MANY_FILES，装进来的不超过那道闸', () => {
    const many = path.join(TMP, 'many-skill', 'files')
    fs.mkdirSync(many, { recursive: true })
    for (let i = 0; i < SKILL_DIR_MAX_FILES + 5; i++) {
      fs.writeFileSync(path.join(many, `f${i}.txt`), 'x', 'utf8')
    }
    const r = readSkillFolder(path.join(TMP, 'many-skill', 'files'))
    // 这一份源目录里没有 SKILL.md，readSkillFolder 会直接报错——改用底层清单条数上限来验：
    // 直接构造超限清单喂给 installSkillFiles（上限那一档在两条路上都得成立）
    void r
    const files = Array.from({ length: SKILL_DIR_MAX_FILES + 3 }, (_, i) => ({
      rel: `f${i}.txt`,
      abs: path.join(many, `f${i}.txt`),
      size: 1
    }))
    const inst = installSkillFiles('s-236-many', files)
    expect(inst.copied.length).toBe(SKILL_DIR_MAX_FILES)
    expect(inst.skipped.some((s) => s.reason === 'TOO_MANY_FILES')).toBe(true)
    expect(listSkillFiles('s-236-many').length).toBe(SKILL_DIR_MAX_FILES)
  })

  it('删技能就是删目录：存在时删干净（正向对照），不存在时回 false（不把"本来就没有"报成失败）', () => {
    expect(fs.existsSync(skillFilesDir('s-236-install'))).toBe(true)
    expect(removeSkillFiles('s-236-install')).toBe(true)
    expect(fs.existsSync(skillFilesDir('s-236-install'))).toBe(false)
    expect(removeSkillFiles('s-236-install')).toBe(false)
  })
})

const canSymlink = (() => {
  const probe = path.join(TMP, 'symlink-probe-target.txt')
  const link = path.join(TMP, 'symlink-probe-link')
  try {
    fs.mkdirSync(TMP, { recursive: true })
    fs.writeFileSync(probe, 'x', 'utf8')
    fs.symlinkSync(probe, link)
    fs.unlinkSync(link)
    return true
  } catch {
    return false
  }
})()

describe('符号链接那一档（Windows 上非开发者模式建不了软链，建不了就如实跳过）', () => {
  it('目录里的符号链接不被带进快照（复制它=把目录外的东西搬成"技能自带"）', { skip: !canSymlink }, () => {
    const dir = path.join(TMP, 'link-skill')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '入口', 'utf8')
    const outside = path.join(TMP, 'outside-secret.txt')
    fs.writeFileSync(outside, '外面那份', 'utf8')
    fs.symlinkSync(outside, path.join(dir, 'leak.txt'))
    const r = readSkillFolder(dir)
    expect(r.files.map((f) => f.rel)).not.toContain('leak.txt')
    expect(r.skipped.some((s) => s.path === 'leak.txt' && s.reason === 'SYMLINK_SKIPPED')).toBe(true)
  })
})
