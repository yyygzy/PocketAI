// artifact_create 工具：注册 / 分组 / 权限 / 执行 / 幂等
//
// 注册面用真 registry（按 tool-groups.test.ts 的既有桩法），执行面用真库 + 真磁盘。
// 要防的回归：
//  · 工具没进 listBuiltin（用户根本调不到）；
//  · 分组漏登记（file 组消息不带关键词时工具消失）；
//  · 权限被误设成 confirm（子 run 里会被摘掉，委派场景产不出文件）；
//  · 同一步重放重复落盘。
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-artifact-tool'
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
import { getArtifactTools } from '../src/main/tools/artifact-tools'
import { ARTIFACTS_DIR, listArtifacts } from '../src/main/artifacts/artifact-service'
import { TOOL_GROUP_OF } from '../src/shared/tool-groups'
import type { ToolExecuteContext } from '../src/main/tools/builtin'

function ctx(requestId: string, stepIndex: number, conversationId = 'conv-1'): ToolExecuteContext {
  return {
    agent: { requestId, conversationId, stepIndex, emit: () => {} }
  }
}

describe('artifact_create 工具', () => {
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
      /* 已关闭 */
    }
    fs.rmSync(P.dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    dbService.getHandle().exec('DELETE FROM artifacts')
    fs.rmSync(ARTIFACTS_DIR, { recursive: true, force: true })
  })

  it('已注册：id / 名称 / auto 权限 / file 分组 / * 授权可见', () => {
    const schema = toolRegistry.getSchema('artifact_create')
    expect(schema?.id).toBe('artifact.create')
    expect(schema?.permission).toBe('auto')
    expect(TOOL_GROUP_OF['artifact.create']).toBe('file')
    expect(toolRegistry.filterByPermissions(['*']).some((t) => t.id === 'artifact.create')).toBe(true)
  })

  it('生成 pptx：摘要、磁盘文件、登记行齐全', async () => {
    const tool = getArtifactTools()[0]!
    const out = await tool.execute(
      { kind: 'pptx', title: '工具产物', slides: [{ title: '封面' }, { title: '要点', bullets: ['离线'] }] },
      ctx('run-1', 1)
    )
    const json = JSON.parse(out)
    expect(json.ok).toBe(true)
    expect(json.kind).toBe('pptx')
    expect(json.fileName).toBe('工具产物.pptx')
    expect(json.slideCount).toBe(2)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, json.fileName))).toBe(true)
    expect(listArtifacts('conv-1')).toHaveLength(1)
  })

  it('生成 docx：摘要、磁盘文件、章节数齐全', async () => {
    const tool = getArtifactTools()[0]!
    const out = await tool.execute(
      {
        kind: 'docx',
        title: '工具 Word',
        subtitle: '验收稿',
        header: '内部',
        sections: [
          { heading: '背景', paragraphs: ['离线优先。'] },
          { heading: '结论', bullets: ['可编辑'] }
        ]
      },
      ctx('run-docx', 1)
    )
    const json = JSON.parse(out)
    expect(json.ok).toBe(true)
    expect(json.kind).toBe('docx')
    expect(json.fileName).toBe('工具 Word.docx')
    expect(json.sectionCount).toBe(2)
    expect(fs.existsSync(path.join(ARTIFACTS_DIR, json.fileName))).toBe(true)
    expect(listArtifacts('conv-1')).toHaveLength(1)
  })

  it('同一步重放：返回原产物（reused=true），不重复落盘', async () => {
    const tool = getArtifactTools()[0]!
    const args = { kind: 'pptx', title: '幂等工具', slides: [{ title: '封面' }] }
    const first = JSON.parse(await tool.execute(args, ctx('run-2', 4)))
    const second = JSON.parse(await tool.execute(args, ctx('run-2', 4)))
    expect(second.id).toBe(first.id)
    expect(second.reused).toBe(true)
    expect(fs.readdirSync(ARTIFACTS_DIR).filter((n) => n.endsWith('.pptx'))).toHaveLength(1)
  })

  it('md 分支：正文按 UTF-8 落盘', async () => {
    const tool = getArtifactTools()[0]!
    const out = JSON.parse(
      await tool.execute({ kind: 'md', title: '说明', markdown: '# 标题\n正文' }, ctx('run-3', 1))
    )
    expect(out.fileName).toBe('说明.md')
    expect(fs.readFileSync(path.join(ARTIFACTS_DIR, out.fileName), 'utf8')).toBe('# 标题\n正文')
  })

  it('缺 slides / 缺 sections / 空 markdown → 稳定错误码，且不落任何文件', async () => {
    const tool = getArtifactTools()[0]!
    await expect(tool.execute({ kind: 'pptx', title: '缺页' }, ctx('run-4', 1))).rejects.toThrow(
      /ARTIFACT_INVALID_SPEC/
    )
    await expect(tool.execute({ kind: 'docx', title: '缺章' }, ctx('run-4', 2))).rejects.toThrow(
      /ARTIFACT_INVALID_SPEC/
    )
    await expect(
      tool.execute({ kind: 'md', title: '空文档', markdown: '   ' }, ctx('run-4', 3))
    ).rejects.toThrow(/ARTIFACT_INVALID_SPEC/)
    expect(listArtifacts()).toEqual([])
    expect(fs.existsSync(ARTIFACTS_DIR) ? fs.readdirSync(ARTIFACTS_DIR) : []).toEqual([])
  })
})
