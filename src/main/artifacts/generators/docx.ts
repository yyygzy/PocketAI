// DOCX 生成器：结构化 spec → .docx 字节（纯函数，不依赖 electron / 数据库，便于单测）
//
// 设计口径（沿用第一片 PPTX 的教训）：
//  · docx 是流式排版，不像 PPT 那样固定盒子里溢出；但**超长正文与超宽表格同样会在 Word 里难看**，
//    所以把上限放在 schema / 生成前校验里：超了直接拒绝（ARTIFACT_INVALID_SPEC），
//    不指望 Word 的自动排版兜底，也不做"打开才发现"的静默降档；
//  · 字号与字体显式写进 run（微软雅黑，正文 11pt / 标题 18-13pt / 表格 10pt），
//    不依赖 Word 默认样式在不同机器上的差异；
//  · v1 不支持图片：模型给的图片路径既不可信也常不存在（与 PPTX 同一理由）；
//  · 页眉/页脚/页码可选：默认页码开启，`pageNumbers:false` 才关。
import {
  AlignmentType,
  Document,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType
} from 'docx'
import { z } from 'zod'

const MAX_TITLE_CHARS = 120
const MAX_SUBTITLE_CHARS = 200
const MAX_SECTIONS = 30
const MAX_HEADING_CHARS = 120
const MAX_PARAGRAPHS = 6
const MAX_PARAGRAPH_CHARS = 600
const MAX_LIST_ITEMS = 10
const MAX_LIST_ITEM_CHARS = 160
const MAX_TABLE_COLS = 5
const MAX_TABLE_ROWS = 15
const MAX_CELL_CHARS = 80
const MAX_HEADER_FOOTER_CHARS = 80
/** 全文合计字数上限：超过就拒绝，避免 mammoth 预览与 Word 打开都变成负担 */
const MAX_TOTAL_CHARS = 40_000

const docxTableSchema = z
  .strictObject({
    headers: z.array(z.string().trim().min(1).max(MAX_CELL_CHARS)).min(1).max(MAX_TABLE_COLS),
    rows: z
      .array(z.array(z.string().max(MAX_CELL_CHARS)).min(1).max(MAX_TABLE_COLS))
      .min(1)
      .max(MAX_TABLE_ROWS)
  })
  .refine((t) => t.rows.every((r) => r.length === t.headers.length), {
    message: '表格每一行的列数必须与表头一致'
  })

const docxSectionSchema = z
  .strictObject({
    heading: z.string().trim().min(1).max(MAX_HEADING_CHARS),
    /** 标题级别 1~3；不给按 1 级处理 */
    level: z.number().int().min(1).max(3).optional(),
    paragraphs: z.array(z.string().trim().min(1).max(MAX_PARAGRAPH_CHARS)).max(MAX_PARAGRAPHS).optional(),
    bullets: z.array(z.string().trim().min(1).max(MAX_LIST_ITEM_CHARS)).max(MAX_LIST_ITEMS).optional(),
    numbered: z.array(z.string().trim().min(1).max(MAX_LIST_ITEM_CHARS)).max(MAX_LIST_ITEMS).optional(),
    table: docxTableSchema.optional()
  })
  .refine(
    (s) =>
      (s.paragraphs?.length ?? 0) > 0 ||
      (s.bullets?.length ?? 0) > 0 ||
      (s.numbered?.length ?? 0) > 0 ||
      Boolean(s.table),
    { message: '每一章至少要有 paragraphs / bullets / numbered / table 之一' }
  )

export const docxSpecSchema = z.strictObject({
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS),
  subtitle: z.string().trim().max(MAX_SUBTITLE_CHARS).optional(),
  /** 页眉文字（可选，≤80 字） */
  header: z.string().trim().max(MAX_HEADER_FOOTER_CHARS).optional(),
  /** 页脚文字（可选，≤80 字） */
  footer: z.string().trim().max(MAX_HEADER_FOOTER_CHARS).optional(),
  /** 页码：默认开；显式 false 才关 */
  pageNumbers: z.boolean().optional(),
  sections: z.array(docxSectionSchema).min(1).max(MAX_SECTIONS)
})

export type DocxSpec = z.infer<typeof docxSpecSchema>

/** zod 错误 → 模型能看懂的单行定位（与 PPTX 生成器同一格式，两个生成器互不依赖） */
function formatSpecError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 5)
      .map((i) => `${i.path.length ? i.path.join('.') : '(根)'}: ${i.message}`)
      .join('；')
  }
  return err instanceof Error ? err.message : String(err)
}

const FONT = 'Microsoft YaHei'
const FONT_ATTRS = { ascii: FONT, hAnsi: FONT, eastAsia: FONT } as const
const INK = '111827'
const BODY = '374151'
const MUTED = '6B7280'
const ACCENT = '2563EB'
const WHITE = 'FFFFFF'

/** docx 的 size 单位是半磅：44=22pt */
const SIZE_TITLE = 44
const SIZE_SUBTITLE = 24
const SIZE_HEADING: Readonly<Record<1 | 2 | 3, number>> = { 1: 36, 2: 30, 3: 26 }
const SIZE_BODY = 22
const SIZE_TABLE = 20
const SIZE_META = 18

const HEADING_LEVELS: Readonly<Record<1 | 2 | 3, (typeof HeadingLevel)[keyof typeof HeadingLevel]>> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3
}

const NUMBERING_REF = 'pocketai-ordered'

function bodyRun(text: string): TextRun {
  return new TextRun({ text, font: FONT_ATTRS, size: SIZE_BODY, color: BODY })
}

function tableCell(text: string, header: boolean, zebra: boolean): TableCell {
  return new TableCell({
    verticalAlign: VerticalAlign.CENTER,
    shading: header
      ? { type: ShadingType.CLEAR, fill: ACCENT, color: 'auto' }
      : zebra
        ? { type: ShadingType.CLEAR, fill: 'F9FAFB', color: 'auto' }
        : undefined,
    children: [
      new Paragraph({
        spacing: { before: 40, after: 40 },
        children: [
          new TextRun({
            text,
            font: FONT_ATTRS,
            size: SIZE_TABLE,
            bold: header,
            color: header ? WHITE : BODY
          })
        ]
      })
    ]
  })
}

function buildTable(table: DocxSpec['sections'][number]['table']): Table {
  if (!table) throw new Error('内部错误：空表格')
  const rows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: table.headers.map((h) => tableCell(h, true, false))
    }),
    ...table.rows.map(
      (r, ri) => new TableRow({ children: r.map((c) => tableCell(c, false, ri % 2 === 0)) })
    )
  ]
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows
  })
}

function countChars(spec: DocxSpec): number {
  let n = Array.from(spec.title).length
  n += Array.from(spec.subtitle ?? '').length
  n += Array.from(spec.header ?? '').length
  n += Array.from(spec.footer ?? '').length
  for (const s of spec.sections) {
    n += Array.from(s.heading).length
    for (const p of s.paragraphs ?? []) n += Array.from(p).length
    for (const b of s.bullets ?? []) n += Array.from(b).length
    for (const b of s.numbered ?? []) n += Array.from(b).length
    if (s.table) {
      for (const h of s.table.headers) n += Array.from(h).length
      for (const row of s.table.rows) for (const c of row) n += Array.from(c).length
    }
  }
  return n
}

function sectionChildren(section: DocxSpec['sections'][number]): Array<Paragraph | Table> {
  const level = (section.level ?? 1) as 1 | 2 | 3
  const out: Array<Paragraph | Table> = [
    new Paragraph({
      heading: HEADING_LEVELS[level],
      spacing: { before: 240, after: 120 },
      children: [
        new TextRun({
          text: section.heading,
          font: FONT_ATTRS,
          size: SIZE_HEADING[level],
          bold: true,
          color: INK
        })
      ]
    })
  ]
  for (const p of section.paragraphs ?? []) {
    out.push(new Paragraph({ spacing: { after: 120 }, children: [bodyRun(p)] }))
  }
  for (const b of section.bullets ?? []) {
    out.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [bodyRun(b)] }))
  }
  for (const b of section.numbered ?? []) {
    out.push(
      new Paragraph({
        numbering: { reference: NUMBERING_REF, level: 0 },
        spacing: { after: 60 },
        children: [bodyRun(b)]
      })
    )
  }
  if (section.table) {
    out.push(buildTable(section.table))
    // 表格后留一点气口（docx 的表格本身不带段后距）
    out.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: '' })] }))
  }
  return out
}

export async function buildDocx(spec: unknown): Promise<Buffer> {
  const parsed = docxSpecSchema.safeParse(spec)
  if (!parsed.success) {
    throw new Error(`[ARTIFACT_INVALID_SPEC] ${formatSpecError(parsed.error)}`)
  }
  const data = parsed.data
  const total = countChars(data)
  if (total > MAX_TOTAL_CHARS) {
    throw new Error(
      `[ARTIFACT_INVALID_SPEC] 全文合计 ${total} 字，超过 ${MAX_TOTAL_CHARS} 字上限；请拆分成多份文档`
    )
  }

  const children: Array<Paragraph | Table> = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 120 },
      children: [
        new TextRun({ text: data.title, font: FONT_ATTRS, size: SIZE_TITLE, bold: true, color: INK })
      ]
    })
  ]
  if (data.subtitle) {
    children.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
        children: [
          new TextRun({
            text: data.subtitle,
            font: FONT_ATTRS,
            size: SIZE_SUBTITLE,
            color: MUTED
          })
        ]
      })
    )
  }
  for (const s of data.sections) children.push(...sectionChildren(s))

  const headers = data.header
    ? {
        default: new Header({
          children: [
            new Paragraph({
              alignment: AlignmentType.RIGHT,
              children: [
                new TextRun({ text: data.header, font: FONT_ATTRS, size: SIZE_META, color: MUTED })
              ]
            })
          ]
        })
      }
    : undefined

  const footerParagraphs: Paragraph[] = []
  if (data.footer) {
    footerParagraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ text: data.footer, font: FONT_ATTRS, size: SIZE_META, color: MUTED })
        ]
      })
    )
  }
  if (data.pageNumbers !== false) {
    footerParagraphs.push(
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            children: [PageNumber.CURRENT],
            font: FONT_ATTRS,
            size: SIZE_META,
            color: MUTED
          })
        ]
      })
    )
  }
  const footers = footerParagraphs.length > 0 ? { default: new Footer({ children: footerParagraphs }) } : undefined

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT_ATTRS, size: SIZE_BODY, color: BODY },
          paragraph: { spacing: { after: 120 } }
        }
      }
    },
    numbering: {
      config: [
        {
          reference: NUMBERING_REF,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.START,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } }
            }
          ]
        }
      ]
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, right: 1134, bottom: 1134, left: 1134 } } },
        ...(headers ? { headers } : {}),
        ...(footers ? { footers } : {}),
        children
      }
    ]
  })

  return Buffer.from(await Packer.toBuffer(doc))
}
