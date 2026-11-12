// project_create 工具：注册 / 分组 / 权限 / 执行 / 幂等 / 失败返回形状
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-project-tool'
  return { dir, db: dir + sep + 'app.db' }
})

vi.mock('../src/main/portable', () => ({ DATA_DIR: P.dir, DB_PATH: P.db }))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))
vi.mock('../src/main/tools/shell-config', () => ({
  getShellConfig: () => ({ enabled: false, policy: 'confirm' })
}))
vi.mock('../src/main/db/repositories/app-config.repo', () => ({
  appConfigRepo: { get: () => null, set: () => {}, delete: () => {} }
}))
vi.mock('../src/main/db/repositories/mcp-server.repo', () => ({
  mcpServerRepo: { list: () => [], get: () => undefined }
}))
vi.mock('../src/main/db/repositories/skill.repo', () => ({
  skillRepo: { list: () => [], listEnabledByIds: () => [], get: () => undefined }
}))
vi.mock('../src/main/mcp/manager', () => ({
  mcpManager: { listRuntimes: () => [], callTool: async () => ({ isError: false }) }
}))

import { dbService } from '../src/main/db/database'
import { toolRegistry } from '../src/main/tools/registry'
import { getProjectTools } from '../src/main/tools/project-tools'
import { PROJECTS_DIR } from '../src/main/projects/project-service'
import { TOOL_GROUP_OF } from '../src/shared/tool-groups'
import type { ToolExecuteContext } from '../src/main/tools/builtin'

function ctx(requestId: string, stepIndex: number, conversationId = 'conv-1'): ToolExecuteContext {
  return { agent: { requestId, conversationId, stepIndex, emit: () => {} } }
}

describe('project_create', () => {
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

  it('已注册、在 file 组、权限是 auto', () => {
    const schema = toolRegistry.listBuiltin().find((t) => t.id === 'project.create')
    expect(schema).toBeTruthy()
    expect(schema?.name).toBe('project_create')
    expect(TOOL_GROUP_OF['project.create']).toBe('file')
    expect(schema?.permission).toBe('auto')
    expect(getProjectTools()).toHaveLength(1)
  })

  it('执行成功：JSON 里带 id/文件夹计数/relPath/不是文件的提示', async () => {
    const tool = getProjectTools()[0]!
    const out = JSON.parse(
      await tool.execute(
        {
          name: '工具项目',
          files: [
            { path: 'index.html', content: '<html><body>hi</body></html>' },
            { path: 'README.md', content: '# hi' }
          ]
        },
        ctx('run-p1', 0)
      )
    )
    expect(out.ok).toBe(true)
    expect(out.dirName).toBe('工具项目')
    expect(out.fileCount).toBe(2)
    expect(out.relPath).toBe('generated/projects/工具项目')
    expect(out.note).toContain('文件夹')
    expect(fs.existsSync(path.join(PROJECTS_DIR, '工具项目', 'index.html'))).toBe(true)
  })

  it('同运行同工具步重放返回 reused=true，不新建目录', async () => {
    const tool = getProjectTools()[0]!
    const args = { name: '幂等项目', files: [{ path: 'a.txt', content: 'a' }] }
    const first = JSON.parse(await tool.execute(args, ctx('run-p2', 1)))
    const second = JSON.parse(await tool.execute(args, ctx('run-p2', 1)))
    expect(second.reused).toBe(true)
    expect(second.id).toBe(first.id)
    expect(fs.readdirSync(PROJECTS_DIR)).toHaveLength(1)
  })

  it('非法参数/非法路径返回 {ok:false, code, path}，不抛异常、不落盘', async () => {
    const tool = getProjectTools()[0]!
    const badArgs = JSON.parse(await tool.execute({ name: 'x', files: [] }, ctx('run-p3', 0)))
    expect(badArgs.ok).toBe(false)
    expect(badArgs.code).toBe('PROJECT_INVALID_SPEC')

    const badPath = JSON.parse(
      await tool.execute({ name: 'x', files: [{ path: '../escape', content: 'x' }] }, ctx('run-p3', 1))
    )
    expect(badPath.ok).toBe(false)
    expect(badPath.code).toBe('PROJECT_INVALID_SPEC')
    expect(badPath.path).toBe('../escape')
    expect(fs.existsSync(PROJECTS_DIR) ? fs.readdirSync(PROJECTS_DIR) : []).toEqual([])
  })
})
