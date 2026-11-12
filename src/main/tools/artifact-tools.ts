// 成品文件生成工具（artifact.create）
//
// 契约：模型只给结构化 spec，生成与落盘都在主进程完成。
// 权限：auto——产物只写应用自有的 DATA_DIR/generated/，不碰用户工作目录、同名绝不覆盖、
// 可在界面上删除；因此不需要逐次审批（confirm 类工具在子 run 里会被摘掉，产物能力会失效）。
// 返回：只给 ≤1KB 的摘要（引擎给 LLM 的副本还会压到 2000 字），完整信息由产物表 + IPC 提供。
import { z } from 'zod'
import type { BuiltinTool } from './builtin'
import { buildPptx, formatSpecError } from '../artifacts/generators/pptx'
import type { ArtifactMeta } from '../../shared/types'

// 注意：**不要在模块顶层 import `artifact-service`**。它 → `portable` → 导入期读 `app.isPackaged`，
// 而 `registry` 会被一批不碰 electron 的 node 单测（registry / tool-name-collision）直接 import，
// 顶层静态引入会让它们一 import 就崩。副作用留到 execute 里再解析。

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

const argsSchema = z.object({
  kind: z.enum(['pptx', 'md']),
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(200).optional(),
  slides: z.unknown().optional(),
  markdown: z.string().optional()
})

function badSpec(detail: string): Error {
  return new Error(`[ARTIFACT_INVALID_SPEC] ${detail}`)
}

function summarize(location: string, meta: ArtifactMeta, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    id: meta.id,
    kind: meta.kind,
    title: meta.title,
    fileName: meta.fileName,
    size: meta.size,
    location,
    ...extra,
    hint: '文件已保存。界面会显示产物卡片；如需放到别处，用卡片上的「另存为」。'
  })
}

const artifactCreateTool: BuiltinTool = {
  schema: {
    id: 'artifact.create',
    name: 'artifact_create',
    description:
      '生成一份可打开的成品文件并保存到应用的「生成的文件」目录。' +
      'kind=pptx：用 slides 给出每页标题与要点（也可给 table 表格），主进程会排版成**可编辑的 PowerPoint**；' +
      'kind=md：用 markdown 给正文，生成 Markdown 文件。' +
      '只在用户明确要「做一份 PPT / 演示文稿 / 文档文件」时调用；普通聊天回答不要调用。' +
      '一页放 3~4 条要点、每条不超过 60 字；上限是每页 6 条、每条 160 字，超出会自动续页。' +
      '需要罗列数据时用 table（表头与每行列数必须一致）。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['pptx', 'md'],
          description: '产物类型：pptx=PowerPoint；md=Markdown 文档'
        },
        title: {
          type: 'string',
          description: '文件名与封面标题（≤120 字，不要带 / \\ : * ? " < > | 等非法字符）'
        },
        subtitle: { type: 'string', description: 'pptx 副标题（可选，≤200 字）' },
        slides: {
          type: 'array',
          description: 'kind=pptx 必填：1~60 页。每页一个对象。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '本页标题（≤120 字）' },
              bullets: {
                type: 'array',
                description: '要点列表（≤6 条，每条 ≤160 字）；与 table 二选一',
                items: { type: 'string' }
              },
              table: {
                type: 'object',
                description: '表格（可选）；给了表格就不要再给 bullets',
                properties: {
                  headers: {
                    type: 'array',
                    description: '表头（1~6 列，≤60 字/格）',
                    items: { type: 'string' }
                  },
                  rows: {
                    type: 'array',
                    description: '数据行（≤12 行）；每行列数必须与表头一致',
                    items: { type: 'array', items: { type: 'string' } }
                  }
                },
                required: ['headers', 'rows'],
                additionalProperties: false
              },
              notes: { type: 'string', description: '演讲者备注（可选，≤2000 字）' }
            },
            required: ['title'],
            additionalProperties: false
          }
        },
        markdown: {
          type: 'string',
          description: 'kind=md 必填：Markdown 正文（≤2MB）'
        }
      },
      required: ['kind', 'title'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 30_000
  },

  async execute(args, ctx) {
    const parsed = argsSchema.safeParse(args)
    if (!parsed.success) {
      throw badSpec(formatSpecError(parsed.error))
    }
    const input = parsed.data
    // 首次真正产出时才拉起落盘模块（见文件头：顶层引入会把 electron 副作用带进纯 node 单测）
    const { ARTIFACTS_DIR, cleanArtifactTitle, findReusableArtifact, saveArtifact } = await import(
      '../artifacts/artifact-service'
    )
    const title = cleanArtifactTitle(input.title)
    const agent = ctx?.agent
    const requestId = agent?.requestId ?? null
    const stepIndex = typeof agent?.stepIndex === 'number' ? agent.stepIndex : null

    // 重启重放：同一次运行的同一工具步已经产出过同标题文件 → 直接返回原产物，不再生成一份
    if (requestId && stepIndex !== null) {
      const reusable = findReusableArtifact(requestId, stepIndex, input.kind, title)
      if (reusable) {
        return summarize(ARTIFACTS_DIR, reusable, { reused: true })
      }
    }

    if (input.kind === 'pptx') {
      if (!input.slides) throw badSpec('kind=pptx 时必须提供 slides 数组')
      const bytes = await buildPptx({
        title: input.title,
        ...(input.subtitle ? { subtitle: input.subtitle } : {}),
        slides: input.slides
      })
      const meta = saveArtifact({
        kind: 'pptx',
        title,
        bytes,
        conversationId: agent?.conversationId ?? null,
        requestId,
        stepIndex
      })
      const slideCount = Array.isArray(input.slides) ? input.slides.length : 0
      return summarize(ARTIFACTS_DIR, meta, { slideCount })
    }

    const markdown = input.markdown ?? ''
    if (!markdown.trim()) throw badSpec('kind=md 时必须提供非空的 markdown 内容')
    const bytes = Buffer.from(markdown, 'utf8')
    if (bytes.length > MAX_MARKDOWN_BYTES) {
      throw badSpec(`markdown 内容超过 ${MAX_MARKDOWN_BYTES / 1024 / 1024}MB 上限`)
    }
    const meta = saveArtifact({
      kind: 'md',
      title,
      bytes,
      conversationId: agent?.conversationId ?? null,
      requestId,
      stepIndex
    })
    return summarize(ARTIFACTS_DIR, meta)
  }
}

export function getArtifactTools(): BuiltinTool[] {
  return [artifactCreateTool]
}
