// project_create 写用户工作目录（§B）：目标守卫 / 动态 confirm / 审批字段 / 落盘事务。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-project-ws-482'
  return { dir, db: dir + sep + 'app.db', ws: dir + sep + 'workspace', data: dir + sep + 'data' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

import { dbService } from '../src/main/db/database'
import { appConfigRepo } from '../src/main/db/repositories/app-config.repo'
import { getProjectTools, buildProjectApprovalPreview } from '../src/main/tools/project-tools'
import { createProject, createProjectToWorkspace, PROJECTS_DIR } from '../src/main/projects/project-service'
import { resolveProjectTarget } from '../src/main/projects/project-target'

const WS = P.ws
const APPS = path.join(WS, 'apps')
const tool = getProjectTools()[0]!

const spec = (name = 'demo') => ({
  name,
  files: [
    { path: 'index.html', content: '<!DOCTYPE html><html><body><h1>Hi</h1></body></html>' },
    { path: 'src/app.js', content: 'console.log("ok")' }
  ]
})

function tmpLeftovers(dir: string): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((n) => n.startsWith('.tmp-'))
}

describe('project_create 工作目录目标（v71）', () => {
  beforeAll(() => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(WS, { recursive: true })
    fs.mkdirSync(APPS, { recursive: true })
    fs.mkdirSync(P.data, { recursive: true })
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
    appConfigRepo.set('agent.workspace_dir', WS)
    fs.rmSync(APPS, { recursive: true, force: true })
    fs.mkdirSync(APPS, { recursive: true })
    fs.rmSync(PROJECTS_DIR, { recursive: true, force: true })
  })

  it('目标守卫：绝对/盘符/UNC/../保留名/尾随点空格/ADS 全拒，正常相对路径通过', () => {
    for (const bad of [
      'C:/tmp/x',
      'C:x',
      '/etc',
      '\\\\srv\\share\\x',
      '..',
      '../x',
      'a/../b',
      'foo.',
      'foo ',
      'con',
      'nul.txt',
      'a:b',
      '@outputs/x',
      ''
    ]) {
      const r = resolveProjectTarget(bad)
      expect(r.ok, `应拒绝：${JSON.stringify(bad)}`).toBe(false)
    }
    const dot = resolveProjectTarget('.')
    expect(dot.ok).toBe(true)
    if (dot.ok) expect(dot.abs).toBe(path.resolve(WS))

    const rel = resolveProjectTarget('apps/demo')
    expect(rel.ok).toBe(true)
    if (rel.ok) expect(rel.abs).toBe(path.resolve(WS, 'apps/demo'))
  })

  it('目标守卫：未设置工作目录时回 NO_WORKSPACE', () => {
    appConfigRepo.delete('agent.workspace_dir')
    const r = resolveProjectTarget('apps')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('PROJECT_TARGET_NO_WORKSPACE')
  })

  it('目标守卫：符号链接指向工作目录外时拒绝（无权限建链接则跳过）', () => {
    const outside = path.join(P.dir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    const link = path.join(WS, 'escape-link')
    try {
      fs.symlinkSync(outside, link, 'dir')
    } catch {
      return // Windows 未开开发者模式/无权限：这条形态由 realpath 用例在 CI 覆盖
    }
    const r = resolveProjectTarget('escape-link')
    expect(r.ok).toBe(false)
  })

  it('classify：不传 target 保持 allow；传工作目录 target 收紧成 confirm+forceConfirm；逃逸 deny', () => {
    expect(tool.classify?.({ name: 'x', files: [] })?.decision).toBe('allow')
    expect(tool.classify?.({ name: 'x', files: [], target: '' })?.decision).toBe('allow')

    const ok = tool.classify?.({ name: 'x', files: [], target: 'apps' })
    expect(ok?.decision).toBe('confirm')
    expect(ok?.reason).toBe('PROJECT_WRITE_WORKSPACE')
    expect(ok?.forceConfirm).toBe(true)

    const bad = tool.classify?.({ name: 'x', files: [], target: '../out' })
    expect(bad?.decision).toBe('deny')
    expect(bad?.reason).toBe('PROJECT_TARGET_INVALID')

    appConfigRepo.delete('agent.workspace_dir')
    const noWs = tool.classify?.({ name: 'x', files: [], target: 'apps' })
    expect(noWs?.decision).toBe('deny')
    expect(noWs?.reason).toBe('PROJECT_TARGET_NO_WORKSPACE')
  })

  it('审批预览：五个字段、目标是完整路径、files 是清单而不是截断 JSON', () => {
    const preview = buildProjectApprovalPreview({ ...spec(), target: 'apps' })
    expect(preview.reason).toBe('PROJECT_WRITE_WORKSPACE')
    expect(preview.fields.map((f) => f.key)).toEqual([
      'project_name',
      'project_target',
      'project_stats',
      'project_files',
      'project_conflict_free'
    ])
    expect(preview.fields[1]!.value).toBe(path.join(APPS, 'demo'))
    expect(preview.fields[2]!.value).toMatch(/^2 · /)
    expect(preview.fields[3]!.mono).toBe(true)
    expect(preview.fields[3]!.value).toContain('index.html')
    expect(preview.fields[3]!.value).not.toContain('{')
  })

  it('审批预览：同名目录已存在时换成 conflict_exists 并报出实际目录名', () => {
    fs.mkdirSync(path.join(APPS, 'demo'), { recursive: true })
    const preview = buildProjectApprovalPreview({ ...spec(), target: 'apps' })
    expect(preview.reason).toBe('PROJECT_WRITE_WORKSPACE_EXISTS')
    expect(preview.fields[4]!.key).toBe('project_conflict_exists')
    expect(preview.fields[4]!.value).toBe('demo')
  })

  it('写入工作目录：成功、目录完整、不入 projects 表', () => {
    const res = createProjectToWorkspace({ ...spec(), targetDirAbs: APPS })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect('location' in res && res.location).toBe('workspace')
    if (!('location' in res)) return
    expect(res.dirAbs).toBe(path.join(APPS, 'demo'))
    expect(fs.readFileSync(path.join(res.dirAbs, 'index.html'), 'utf8')).toContain('<h1>Hi</h1>')
    expect(fs.readFileSync(path.join(res.dirAbs, 'src/app.js'), 'utf8')).toBe('console.log("ok")')
    expect(tmpLeftovers(APPS)).toEqual([])
    const rows = dbService.getHandle().prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('写入工作目录：同名直接拒写，不递增、不覆盖、不留 .tmp-', () => {
    fs.mkdirSync(path.join(APPS, 'demo'), { recursive: true })
    fs.writeFileSync(path.join(APPS, 'demo', 'keep.txt'), 'keep')
    const res = createProjectToWorkspace({ ...spec(), targetDirAbs: APPS })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('PROJECT_TARGET_EXISTS')
    expect(fs.readFileSync(path.join(APPS, 'demo', 'keep.txt'), 'utf8')).toBe('keep')
    expect(tmpLeftovers(APPS)).toEqual([])
  })

  it('写入工作目录：大小写不同的同名目录也拒写', () => {
    fs.mkdirSync(path.join(APPS, 'DEMO'), { recursive: true })
    const res = createProjectToWorkspace({ ...spec('demo'), targetDirAbs: APPS })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.code).toBe('PROJECT_TARGET_EXISTS')
    // 只留下原目录，且没有被写入任何新文件
    expect(fs.readdirSync(APPS)).toEqual(['DEMO'])
    expect(fs.existsSync(path.join(APPS, 'DEMO', 'index.html'))).toBe(false)
  })

  it('rename 失败：清临时目录、不留下正式目录', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw new Error('EPERM: operation not permitted')
    })
    try {
      const res = createProjectToWorkspace({ ...spec(), targetDirAbs: APPS })
      expect(res.ok).toBe(false)
      if (!res.ok) expect(res.code).toBe('PROJECT_WRITE_FAILED')
    } finally {
      spy.mockRestore()
    }
    expect(fs.existsSync(path.join(APPS, 'demo'))).toBe(false)
    expect(tmpLeftovers(APPS)).toEqual([])
  })

  it('回归：不传 target 仍写应用目录并入库（同名 -2）', () => {
    const a = createProject(spec())
    const b = createProject(spec())
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect('location' in a).toBe(false)
    expect(a.project.dirName).toBe('demo')
    expect(b.project.dirName).toBe('demo-2')
    expect(a.project.relPath).toBe('generated/projects/demo')
  })
})
