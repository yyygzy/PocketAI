// 多文件项目（v70）：真库 + 真磁盘
//
// 钉住的语义：
//  · 整单事务：中途失败不留半成品、不留 .tmp-*；
//  · 同名自动 -2，绝不合并/覆盖；
//  · 撤销只在全部哈希一致时成立，改过任何一份就 SNAPSHOT_DIVERGED；
//  · ZIP 内容与目录逐文件一致；
//  · 文件数/单文件/总量/路径安全/扩展名黑名单全部拒绝而不截断。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import unzipper from 'unzipper'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-projects-svc'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService, LATEST_SCHEMA_VERSION } from '../src/main/db/database'
import {
  PROJECTS_DIR,
  createProject,
  deleteProject,
  exportProjectZip,
  getProjectPreview,
  normalizeProjectPath
} from '../src/main/projects/project-service'
import { projectsRepo } from '../src/main/db/repositories/projects.repo'

const spec = (name = '示例项目') => ({
  name,
  files: [
    { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>' },
    { path: 'README.md', content: '# 示例\n\n说明。' },
    { path: 'src/app.js', content: 'console.log("ok")' }
  ]
})

describe('project-service（真库 + 真磁盘）', () => {
  beforeAll(() => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(P.dir, { recursive: true })
    dbService.open()
    dbService.runMigrations()
  })

  afterAll(() => {
    try {
      dbService.close()
    } catch {
      /* ignore */
    }
    fs.rmSync(P.dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    fs.rmSync(PROJECTS_DIR, { recursive: true, force: true })
    dbService.getHandle().prepare('DELETE FROM project_files').run()
    dbService.getHandle().prepare('DELETE FROM projects').run()
  })

  it('v70 迁移建出 projects / project_files', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(71)
    const tables = (
      dbService
        .getHandle()
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['projects', 'project_files']))
  })

  it('正常生成：目录、文件内容、清单哈希与总字节都对', () => {
    const res = createProject(spec())
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.project.fileCount).toBe(3)
    expect(res.project.dirName).toBe('示例项目')
    const dir = path.join(PROJECTS_DIR, res.project.dirName)
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<h1>Hi</h1>')
    expect(fs.readFileSync(path.join(dir, 'src/app.js'), 'utf8')).toBe('console.log("ok")')
    const files = projectsRepo.listFiles(res.project.id)
    expect(files.map((f) => f.path)).toEqual(['README.md', 'index.html', 'src/app.js'])
    expect(files.every((f) => /^[a-f0-9]{64}$/.test(f.sha256))).toBe(true)
    expect(files.reduce((n, f) => n + f.size, 0)).toBe(res.project.totalBytes)
  })

  it('同名再生成自动 -2，原目录内容不动', () => {
    const a = createProject(spec('同名'))
    const b = createProject(spec('同名'))
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(a.project.dirName).toBe('同名')
    expect(b.project.dirName).toBe('同名-2')
  })

  it('同运行同工具步复用（reused=true），不重复落盘', () => {
    const first = createProject({ ...spec('幂等'), requestId: 'r1', stepIndex: 2 })
    const second = createProject({ ...spec('幂等'), requestId: 'r1', stepIndex: 2 })
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.reused).toBe(true)
    expect(second.project.id).toBe(first.project.id)
    expect(fs.readdirSync(PROJECTS_DIR).filter((n) => !n.startsWith('.tmp-'))).toHaveLength(1)
  })

  it('中途失败（文件与目录同名）不留半成品、不留 .tmp、不落库', () => {
    const res = createProject({
      name: '坏项目',
      files: [
        { path: 'a', content: 'file' },
        { path: 'a/b.txt', content: 'cannot mkdir under a file' }
      ]
    })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('PROJECT_WRITE_FAILED')
    const leftovers = fs.existsSync(PROJECTS_DIR) ? fs.readdirSync(PROJECTS_DIR) : []
    expect(leftovers.filter((n) => n.startsWith('.tmp-'))).toEqual([])
    expect(leftovers).not.toContain('坏项目')
    const count = dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
    expect(count.n).toBe(0)
  })

  it('非法路径一律拒绝：绝对路径/盘符/../保留名/尾随点/可执行扩展名', () => {
    const bad = ['/etc/passwd', 'C:\\Windows\\a.txt', '../escape.txt', 'a/../../b', 'CON.txt', 'dir./x', 'x. ', 'run.exe', 'setup.bat', 'x.ps1']
    for (const p of bad) {
      expect(normalizeProjectPath(p).ok, p).toBe(false)
      const res = createProject({ name: '坏路径', files: [{ path: p, content: 'x' }] })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('PROJECT_INVALID_SPEC')
    }
    expect(fs.existsSync(PROJECTS_DIR) ? fs.readdirSync(PROJECTS_DIR) : []).toEqual([])
  })

  it('文件数 / 单文件 / 总量超限被拒', () => {
    const tooMany = createProject({
      name: '超多',
      files: Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.txt`, content: 'x' }))
    })
    expect(tooMany.ok).toBe(false)

    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const tooBig = createProject({ name: '超大', files: [{ path: 'a.txt', content: big }] })
    expect(tooBig.ok).toBe(false)

    const chunk = 'x'.repeat(2 * 1024 * 1024)
    const tooTotal = createProject({
      name: '总量',
      files: Array.from({ length: 26 }, (_, i) => ({ path: `f${i}.txt`, content: chunk }))
    })
    expect(tooTotal.ok).toBe(false)
    if (!tooTotal.ok) expect(tooTotal.message).toContain('总字节')
  })

  it('撤销：哈希全一致才删；文件被改/多出文件都拒绝并报路径', () => {
    const res = createProject(spec('可撤销'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const dir = path.join(PROJECTS_DIR, res.project.dirName)
    fs.writeFileSync(path.join(dir, 'README.md'), '# 改过', 'utf8')
    const diverged = deleteProject(res.project.id)
    expect(diverged.ok).toBe(false)
    if (!diverged.ok) {
      expect(diverged.code).toBe('SNAPSHOT_DIVERGED')
      expect(diverged.path).toBe('README.md')
    }
    expect(fs.existsSync(dir)).toBe(true)

    fs.writeFileSync(path.join(dir, 'README.md'), '# 示例\n\n说明。', 'utf8')
    fs.writeFileSync(path.join(dir, 'extra.txt'), 'extra', 'utf8')
    const extra = deleteProject(res.project.id)
    expect(extra.ok).toBe(false)
    if (!extra.ok) expect(extra.path).toBe('extra.txt')

    fs.rmSync(path.join(dir, 'extra.txt'))
    const ok = deleteProject(res.project.id)
    expect(ok.ok).toBe(true)
    expect(fs.existsSync(dir)).toBe(false)
    expect(projectsRepo.get(res.project.id)).toBeNull()
  })

  it('ZIP 内容与目录逐文件一致', async () => {
    const res = createProject(spec('打包'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const zip = await exportProjectZip(res.project.id)
    expect(zip.ok).toBe(true)
    if (!zip.ok) return
    expect(zip.bytes).toBeGreaterThan(0)
    const dir = await unzipper.Open.file(path.join(PROJECTS_DIR, zip.fileName))
    const entries = dir.files.filter((f) => f.type === 'File').map((f) => f.path).sort()
    expect(entries).toEqual(['打包/README.md', '打包/index.html', '打包/src/app.js'])
    const index = dir.files.find((f) => f.path === '打包/index.html')!
    expect((await index.buffer()).toString('utf8')).toContain('<h1>Hi</h1>')
  })

  it('预览：index.html / README.md / 文件清单', () => {
    const res = createProject(spec('预览'))
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const p = getProjectPreview(res.project.id)
    expect(p?.indexHtml).toContain('<h1>Hi</h1>')
    expect(p?.readme).toContain('# 示例')
    expect(p?.files.map((f) => f.path)).toEqual(['README.md', 'index.html', 'src/app.js'])
    expect(p?.relPath).toBe('generated/projects/预览')
  })
})
