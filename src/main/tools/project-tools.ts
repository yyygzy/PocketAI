// project_create：把多个 UTF-8 文本文件整单写成一个目录（v70；v71 起支持写工作目录）。
// 与 artifact.create 的区别：产物是**文件夹**，不是一个文件，所以不共用 kind。
//
// 双目标口径：
//  · 不传 `target`：写应用自有目录 DATA_DIR/generated/projects/，权限仍是 auto（行为与 v70 一致）；
//  · 传 `target`（Agent 工作目录内的相对路径）：写用户工作目录，classify 收紧成 confirm，
//    并且 forceConfirm（参数含全部文件内容，会话白名单对项目写入没有意义）。
//    —— 静态 permission 保持 auto，所以子 run 仍能写应用目录；写工作目录的调用在子 run
//    会因 confirm + unattended 得到「需人工确认」的可读失败，而不是整颗工具消失。
import path from 'node:path'
import { z } from 'zod'
import type { BuiltinTool } from './builtin'
import type { ApprovalPreviewField } from '../../shared/types'
import {
  cleanProjectName,
  findCaseInsensitiveEntry,
  resolveProjectTarget
} from '../projects/project-target'

const fileSchema = z.strictObject({
  path: z.string().min(1).max(240),
  content: z.string()
})

const projectSpecSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  files: z.array(fileSchema).min(1).max(200),
  target: z.string().min(1).max(400).optional()
})

function formatBytesShort(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

const projectCreateTool: BuiltinTool = {
  schema: {
    id: 'project.create',
    name: 'project_create',
    source: 'builtin',
    permission: 'auto',
    description:
      '把一个多文件代码项目写成**一个文件夹**（不是单个文件）。' +
      '默认落在 PocketAI 自己的产物目录下；只有显式传 target（Agent 工作目录内的相对路径）时才写用户工作目录，' +
      '写工作目录前会**先请你确认**。只在用户明确要「做一个项目 / 网页 / 多文件代码」时调用；普通回答不要调用。' +
      '参数 files 是 [{path, content}]：path 必须是项目内相对路径（如 src/main.ts），content 是 UTF-8 文本。' +
      '路径禁止绝对路径、盘符、..、Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）、尾随点或空格；' +
      '禁止 .exe/.dll/.msi/.scr/.com/.pif/.lnk/.bat/.ps1 等可执行扩展名。' +
      '上限：≤200 个文件、总量 ≤50MB、单文件 ≤2MB、路径 ≤240 字符；超限直接拒绝，不截断。' +
      '同名冲突：应用目录自动改成「名称-2」；工作目录直接拒绝，请换一个项目名或 target。' +
      '写盘是整单事务：要么完整生成，要么什么都不留。',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: '项目名（1~80 字，作为目录名；应用目录同名自动加 -2，工作目录同名直接拒绝）'
        },
        target: {
          type: 'string',
          description:
            '可选。Agent 工作目录内的相对父目录（如 apps/demo），写入时会先请你确认；' +
            '不传则写 PocketAI 自己的产物目录。禁止绝对路径、盘符、UNC、..、保留名。'
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

  classify(args) {
    const raw = args.target
    // 不传 target = 继续写应用目录，维持 auto，不前移审批
    if (raw === undefined || raw === null || raw === '') return { decision: 'allow' }
    const target = resolveProjectTarget(raw)
    if (!target.ok) return { decision: 'deny', reason: target.reason }
    return {
      decision: 'confirm',
      reason: 'PROJECT_WRITE_WORKSPACE',
      // 参数里带着整单文件内容，指纹几乎永不命中；开了「总是允许」也是假的，索性不给
      forceConfirm: true
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
    // classify 已判过；执行前再解析一次（classify 与 execute 之间目标可能被改）
    const target =
      parsed.data.target === undefined ? null : resolveProjectTarget(parsed.data.target)
    if (target && !target.ok) {
      return JSON.stringify({ ok: false, code: target.reason, message: target.message })
    }
    // 惰性 import：project-service → portable 顶层会读 electron app，
    // 不在工具模块加载期碰它（与「工具 schema 先于 app ready 被列举」的场景对齐）。
    const svc = await import('../projects/project-service')
    const base = {
      name: parsed.data.name,
      files: parsed.data.files,
      conversationId: ctx?.agent?.conversationId ?? null,
      requestId: ctx?.agent?.requestId ?? null,
      stepIndex: ctx?.agent?.stepIndex ?? null
    }
    const result =
      target && target.ok
        ? svc.createProjectToWorkspace({ ...base, targetDirAbs: target.abs })
        : svc.createProject(base)
    if (!result.ok) return JSON.stringify(result)
    if ('location' in result) {
      return JSON.stringify({
        ok: true,
        location: 'workspace',
        name: result.name,
        dirAbs: result.dirAbs,
        fileCount: result.fileCount,
        totalBytes: result.totalBytes,
        note: '已写入 Agent 工作目录。这是工作目录里的文件夹，不在 PocketAI 产物目录内。'
      })
    }
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

/**
 * project_create 的审批预览（引擎 buildApprovalDisplay 调用）。
 * 不走 buildToolPreviewFields 的通用启发式：`files` 是数组，通用路径会把它序列化后截成半截 JSON。
 * 这里不抛错——弹窗正在等一份能看的东西，判不出目标就退回原始 target。
 */
export function buildProjectApprovalPreview(args: Record<string, unknown>): {
  command: string
  reason: string
  fields: ApprovalPreviewField[]
} {
  const rawName = typeof args.name === 'string' ? args.name : ''
  const name = cleanProjectName(rawName)
  const target = resolveProjectTarget(args.target)
  const rawTarget = typeof args.target === 'string' ? args.target : ''
  const targetAbs = target.ok ? path.join(target.abs, name) : rawTarget

  const files = Array.isArray(args.files) ? args.files : []
  const paths: string[] = []
  let bytes = 0
  for (const item of files) {
    if (!item || typeof item !== 'object') continue
    const f = item as Record<string, unknown>
    if (typeof f.path === 'string') paths.push(f.path)
    if (typeof f.content === 'string') bytes += Buffer.byteLength(f.content, 'utf8')
  }
  const head = paths.slice(0, 8).join('\n')
  const fileList = paths.length > 8 ? `${head}\n… +${paths.length - 8}` : head
  const conflict = target.ok ? findCaseInsensitiveEntry(target.abs, name) : null

  return {
    command: `${name} → ${targetAbs || '(target)'}`,
    reason: conflict ? 'PROJECT_WRITE_WORKSPACE_EXISTS' : 'PROJECT_WRITE_WORKSPACE',
    fields: [
      { key: 'project_name', value: name },
      { key: 'project_target', value: targetAbs || '—' },
      { key: 'project_stats', value: `${paths.length} · ${formatBytesShort(bytes)}` },
      { key: 'project_files', value: fileList || '—', mono: true },
      // 冲突状态用 key 区分（四语文案同键），value 放实际命中的目录名
      {
        key: conflict ? 'project_conflict_exists' : 'project_conflict_free',
        value: conflict ?? '—'
      }
    ]
  }
}

export function getProjectTools(): BuiltinTool[] {
  return [projectCreateTool]
}
