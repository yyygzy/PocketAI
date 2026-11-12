// project_create：把多个 UTF-8 文本文件整单写成一个目录（v70）。
// 与 artifact.create 的区别：产物是**文件夹**，不是一个文件，所以不共用 kind。
//
// v1 只写应用自有目录 DATA_DIR/generated/projects/（权限 auto），不写用户工作目录；
// 后者要走 confirm 审批面，留给下一刀。
import { z } from 'zod'
import type { BuiltinTool } from './builtin'

const fileSchema = z.strictObject({
  path: z.string().min(1).max(240),
  content: z.string()
})

const projectSpecSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  files: z.array(fileSchema).min(1).max(200)
})

const projectCreateTool: BuiltinTool = {
  schema: {
    id: 'project.create',
    name: 'project_create',
    source: 'builtin',
    permission: 'auto',
    description:
      '把一个多文件代码项目写成**一个文件夹**（不是单个文件），落在 PocketAI 自己的产物目录下。' +
      '只在用户明确要「做一个项目 / 网页 / 多文件代码」时调用；普通回答不要调用。' +
      '参数 files 是 [{path, content}]：path 必须是项目内相对路径（如 src/main.ts），content 是 UTF-8 文本。' +
      '路径禁止绝对路径、盘符、..、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）、尾随点或空格；' +
      '禁止 .exe/.dll/.msi/.scr/.com/.pif/.lnk/.bat/.ps1 等可执行扩展名。' +
      '上限：≤200 个文件、总量 ≤50MB、单文件 ≤2MB、路径 ≤240 字符；超限直接拒绝，不截断。' +
      '同名项目会自动改成「名称-2」，不合并、不覆盖；同一次运行的同一工具步重复执行会复用已有结果。' +
      '写盘是整单事务：要么完整生成，要么什么都不留。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '项目名（1~80 字，作为目录名；同名自动加 -2）'
        },
        files: {
          type: 'array',
          description: '项目文件列表（1~200 个）',
          items: {
            type: 'object',
            properties: {
              path: {
                type: 'string',
                description: '项目内相对路径，POSIX 分隔符（如 index.html、src/app.js）'
              },
              content: { type: 'string', description: 'UTF-8 文本内容' }
            },
            required: ['path', 'content'],
            additionalProperties: false
          }
        }
      },
      required: ['name', 'files'],
      additionalProperties: false
    }
  },

  async execute(args, ctx) {
    const parsed = projectSpecSchema.safeParse(args)
    if (!parsed.success) {
      const issue = parsed.error.issues[0]
      return JSON.stringify({
        ok: false,
        code: 'PROJECT_INVALID_SPEC',
        path: issue?.path.length ? issue.path.join('.') : undefined,
        message: issue?.message ?? '参数不合法'
      })
    }
    // 惰性 import：project-service → portable 顶层会读 electron app，
    // 不在工具模块加载期碰它（与「工具 schema 先于 app ready 被列举」的场景对齐）。
    const { createProject } = await import('../projects/project-service')
    const result = createProject({
      name: parsed.data.name,
      files: parsed.data.files,
      conversationId: ctx?.agent?.conversationId ?? null,
      requestId: ctx?.agent?.requestId ?? null,
      stepIndex: ctx?.agent?.stepIndex ?? null
    })
    if (!result.ok) return JSON.stringify(result)
    return JSON.stringify({
      ok: true,
      id: result.project.id,
      name: result.project.name,
      dirName: result.project.dirName,
      relPath: result.project.relPath,
      fileCount: result.project.fileCount,
      totalBytes: result.project.totalBytes,
      reused: result.reused,
      note: '这是一个文件夹，不是一个文件。'
    })
  }
}

export function getProjectTools(): BuiltinTool[] {
  return [projectCreateTool]
}
