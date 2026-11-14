// 成品文件生成工具（artifact.create）
//
// 契约：模型只给结构化 spec，生成与落盘都在主进程完成。
// 权限：auto——产物只写应用自有的 DATA_DIR/generated/，不碰用户工作目录、同名绝不覆盖、
// 可在界面上删除；因此不需要逐次审批（confirm 类工具在子 run 里会被摘掉，产物能力会失效）。
// 返回：只给 ≤1KB 的摘要（引擎给 LLM 的副本还会压到 2000 字），完整信息由产物表 + IPC 提供。
import { z } from 'zod'
import type { BuiltinTool } from './builtin'
import { buildPptx, formatSpecError } from '../artifacts/generators/pptx'
import { buildDocx } from '../artifacts/generators/docx'
import { buildXlsx } from '../artifacts/generators/xlsx'
import type { ArtifactMeta } from '../../shared/types'

// 注意：**不要在模块顶层 import `artifact-service`**。它 → `portable` → 导入期读 `app.isPackaged`，
// 而 `registry` 会被一批不碰 electron 的 node 单测（registry / tool-name-collision）直接 import，
// 顶层静态引入会让它们一 import 就崩。副作用留到 execute 里再解析。

const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

const argsSchema = z.object({
  kind: z.enum(['pptx', 'docx', 'xlsx', 'md']),
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(200).optional(),
  header: z.string().trim().max(80).optional(),
  footer: z.string().trim().max(80).optional(),
  pageNumbers: z.boolean().optional(),
  slides: z.unknown().optional(),
  sections: z.unknown().optional(),
  sheets: z.unknown().optional(),
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
      'kind=docx：用 sections 给出章节（标题、段落、有序/无序列表、表格），生成**可编辑的 Word 文档**；' +
      'kind=xlsx：用 sheets 给出工作表（表名、表头、数据行，可选列宽/数字格式/合并区域），生成**可编辑的 Excel 表格**；' +
      'kind=md：用 markdown 给正文，生成 Markdown 文件。' +
      '只在用户明确要「做一份 PPT / 演示文稿 / 文档文件 / Excel 表格」时调用；普通聊天回答不要调用。' +
      'pptx 一页放 3~4 条要点、每条不超过 60 字；上限是每页 6 条、每条 160 字，超出会自动续页。' +
      'docx 一章放 1~3 段；上限是 30 章、每章 6 段（每段 ≤600 字）、列表 ≤10 条（每条 ≤160 字）、' +
      '表格 ≤5 列 × 15 行（单元格 ≤80 字）、全文合计 ≤4 万字——**超了会被拒绝，不会自动压缩**，请自行拆分。' +
      'xlsx 上限：≤10 张表、每张 ≤30 列 × 200 数据行、单元格 ≤200 字、表头 ≤80 字、合并区域 ≤20 个、' +
      '全簿 ≤20000 个单元格、文件 ≤5MB；sheet 名 ≤31 字符且不能重复；**不做单元格字体/底色/边框**' +
      '（SheetJS CE 不支持，不要承诺报表级样式）；数字格式只对数值/公式列生效。' +
      '公式会尽量带上算好的缓存值（WPS / Google Sheets 打开即有内容，Excel 打开仍会重算）；' +
      '缓存值只覆盖可解析的子集：数字、单元格引用（A1 / $A$1）、区域（A1:B4）、+ - * / 与括号、' +
      'SUM / AVERAGE / MIN / MAX / COUNT；跨表引用（Sheet1!A1）、其它函数（IF / VLOOKUP 等）、' +
      '文本拼接不写缓存值（这些公式在 WPS 里可能先显示空白）。错误按 Excel 语义写入 ' +
      '#DIV/0!、#VALUE!、#REF!、#NAME?（越界地址按未定义名称落 #NAME?）；循环引用的公式不写缓存值。' +
      '需要罗列数据时用 table（表头与每行列数必须一致）。',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['pptx', 'docx', 'xlsx', 'md'],
          description: '产物类型：pptx=PowerPoint；docx=Word；xlsx=Excel 表格；md=Markdown 文档'
        },
        title: {
          type: 'string',
          description: '文件名与文档标题（≤120 字，不要带 / \\ : * ? " < > | 等非法字符）'
        },
        subtitle: { type: 'string', description: '副标题（pptx/docx 可选，≤200 字）' },
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
        },
        header: { type: 'string', description: 'docx 页眉（可选，≤80 字）' },
        footer: { type: 'string', description: 'docx 页脚（可选，≤80 字）' },
        pageNumbers: { type: 'boolean', description: 'docx 页码：默认开；传 false 才关' },
        sections: {
          type: 'array',
          description: 'kind=docx 必填：1~30 章。每章一个对象，至少给 paragraphs / bullets / numbered / table 之一。',
          items: {
            type: 'object',
            properties: {
              heading: { type: 'string', description: '章节标题（≤120 字）' },
              level: { type: 'number', description: '标题级别 1~3，默认 1' },
              paragraphs: {
                type: 'array',
                description: '正文段落（≤6 段，每段 ≤600 字）',
                items: { type: 'string' }
              },
              bullets: {
                type: 'array',
                description: '无序列表（≤10 条，每条 ≤160 字）',
                items: { type: 'string' }
              },
              numbered: {
                type: 'array',
                description: '有序列表（≤10 条，每条 ≤160 字）',
                items: { type: 'string' }
              },
              table: {
                type: 'object',
                description: '表格（可选，≤5 列 × 15 行）',
                properties: {
                  headers: {
                    type: 'array',
                    description: '表头（1~5 列，≤80 字/格）',
                    items: { type: 'string' }
                  },
                  rows: {
                    type: 'array',
                    description: '数据行（≤15 行，单元格 ≤80 字）；每行列数必须与表头一致',
                    items: { type: 'array', items: { type: 'string' } }
                  }
                },
                required: ['headers', 'rows'],
                additionalProperties: false
              }
            },
            required: ['heading'],
            additionalProperties: false
          }
        },
        sheets: {
          type: 'array',
          description:
            'kind=xlsx 必填：1~10 张工作表。每张一个对象；首行由 headers 生成，rows 为数据行。' +
            '注意：SheetJS CE 不支持单元格字体/底色/边框，本工具不做单元格样式。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作表名（≤31 字符，自动去掉 []:*?/\\ 等非法字符）' },
              headers: {
                type: 'array',
                description: '表头（1~30 列，≤80 字/格）',
                items: { type: 'string' }
              },
              rows: {
                type: 'array',
                description:
                  '数据行（≤200 行）；每行列数必须与表头一致。单元格可写字符串（≤200 字）、数字，' +
                  '或对象 {"formula":"SUM(B2:B4)"} 表示公式（尽量带缓存值，Excel 打开仍会重算）',
                items: {
                  type: 'array',
                  items: {
                    anyOf: [
                      { type: 'string' },
                      { type: 'number' },
                      {
                        type: 'object',
                        properties: { formula: { type: 'string', description: 'Excel 公式，≤200 字' } },
                        required: ['formula'],
                        additionalProperties: false
                      }
                    ]
                  }
                }
              },
              colWidths: {
                type: 'array',
                description: '列宽（可选，长度必须等于列数；每列 5~100）',
                items: { type: 'number' }
              },
              numberFormats: {
                type: 'array',
                description:
                  '每列数字格式（可选，长度必须等于列数；如 "0.00"、"#,##0"、"0%"；空串表示该列不设格式）',
                items: { type: 'string' }
              },
              merges: {
                type: 'array',
                description:
                  '合并区域（可选，≤20 个；零基坐标，表头行 r=0，数据从 r=1 开始；不能重叠、不能超出表格）',
                items: {
                  type: 'object',
                  properties: {
                    r1: { type: 'number' },
                    c1: { type: 'number' },
                    r2: { type: 'number' },
                    c2: { type: 'number' }
                  },
                  required: ['r1', 'c1', 'r2', 'c2'],
                  additionalProperties: false
                }
              }
            },
            required: ['name', 'headers', 'rows'],
            additionalProperties: false
          }
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

    if (input.kind === 'docx') {
      if (!input.sections) throw badSpec('kind=docx 时必须提供 sections 数组')
      const bytes = await buildDocx({
        title: input.title,
        ...(input.subtitle ? { subtitle: input.subtitle } : {}),
        ...(input.header ? { header: input.header } : {}),
        ...(input.footer ? { footer: input.footer } : {}),
        ...(typeof input.pageNumbers === 'boolean' ? { pageNumbers: input.pageNumbers } : {}),
        sections: input.sections
      })
      const meta = saveArtifact({
        kind: 'docx',
        title,
        bytes,
        conversationId: agent?.conversationId ?? null,
        requestId,
        stepIndex
      })
      const sectionCount = Array.isArray(input.sections) ? input.sections.length : 0
      return summarize(ARTIFACTS_DIR, meta, { sectionCount })
    }

    if (input.kind === 'xlsx') {
      if (!input.sheets) throw badSpec('kind=xlsx 时必须提供 sheets 数组')
      const bytes = await buildXlsx({ title: input.title, sheets: input.sheets })
      const meta = saveArtifact({
        kind: 'xlsx',
        title,
        bytes,
        conversationId: agent?.conversationId ?? null,
        requestId,
        stepIndex
      })
      const sheetCount = Array.isArray(input.sheets) ? input.sheets.length : 0
      return summarize(ARTIFACTS_DIR, meta, {
        sheetCount,
        styleNote: 'SheetJS CE 不支持单元格字体/底色/边框，本文件不含单元格样式。'
      })
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
