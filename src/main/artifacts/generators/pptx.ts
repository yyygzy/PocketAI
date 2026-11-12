// PPTX 生成器：结构化 spec → .pptx 字节（纯函数，不依赖 electron / 数据库，便于单测）
//
// 设计取舍：
//  · 模型只填「标题 + 每页要点/表格」，排版由这里固定，避免模型自由发挥导致版式崩坏；
//  · 字体只写名字不嵌字体（离线产品不背字体授权与体积），统一微软雅黑；
//  · **不依赖 normAutofit 自动收缩**：§471 真机实测 PowerPoint 打开时不会重算 `<a:normAutofit/>`
//    （没有 fontScale 就不缩），字号必须自己按「字符数 × 每行容量 × 行高」算出来再显式写进 rPr；
//  · 一页装不下就自动续页（标题加「（续 N）」），标题超长先降字号、降到下限才截断加省略号；
//  · v1 不支持图片：模型给的图片路径既不可信也常不存在，留到下一刀。
import PptxGenJS from 'pptxgenjs'
import { z } from 'zod'

const MAX_SLIDES = 60
const MAX_BULLETS = 6
const MAX_BULLET_CHARS = 160
const MAX_TABLE_COLS = 6
const MAX_TABLE_ROWS = 12
const MAX_CELL_CHARS = 120

const tableSchema = z
  .strictObject({
    headers: z.array(z.string().trim().min(1).max(60)).min(1).max(MAX_TABLE_COLS),
    rows: z
      .array(z.array(z.string().max(MAX_CELL_CHARS)).min(1).max(MAX_TABLE_COLS))
      .min(1)
      .max(MAX_TABLE_ROWS)
  })
  .refine((t) => t.rows.every((r) => r.length === t.headers.length), {
    message: '表格每一行的列数必须与表头一致'
  })

export const pptxSlideSchema = z
  .strictObject({
    title: z.string().trim().min(1).max(120),
    bullets: z.array(z.string().trim().min(1).max(MAX_BULLET_CHARS)).max(MAX_BULLETS).optional(),
    table: tableSchema.optional(),
    notes: z.string().max(2000).optional()
  })
  .refine((s) => !(s.table && s.bullets && s.bullets.length > 0), {
    message: '同一页不要同时给 bullets 和 table，二选一'
  })

export const pptxSpecSchema = z.strictObject({
  title: z.string().trim().min(1).max(120),
  subtitle: z.string().trim().max(200).optional(),
  slides: z.array(pptxSlideSchema).min(1).max(MAX_SLIDES)
})

export type PptxSpec = z.infer<typeof pptxSpecSchema>

/** zod 错误 → 模型能看懂的单行定位（只给前 5 条，避免刷屏） */
export function formatSpecError(err: unknown): string {
  if (err instanceof z.ZodError) {
    const lines = err.issues.slice(0, 5).map((i) => {
      const at = i.path.length ? i.path.join('.') : '(根)'
      return `${at}: ${i.message}`
    })
    return lines.join('；')
  }
  return err instanceof Error ? err.message : String(err)
}

const THEME = {
  font: 'Microsoft YaHei',
  ink: '111827',
  body: '374151',
  muted: '6B7280',
  accent: '2563EB',
  line: 'E5E7EB',
  zebra: 'F9FAFB',
  white: 'FFFFFF'
} as const

const W = 13.33
const H = 7.5
const MARGIN = 0.8
const PT = 72

// ---------- 版式估算（口径与 §471 真机实测对齐） ----------
// 汉字按 1em、ASCII 按 0.55em、空格 0.3em；行高：标题 1.2em（实测 40pt 三行=144pt、28pt 两行=67.2pt），
// 正文带 lineSpacingMultiple 1.35 ⇒ 1.35 × 1.2 = 1.62em（实测 17pt 六条共 988.6pt ≈ 每行 27.5pt）。
const TITLE_LINE_FACTOR = 1.2
const BODY_LINE_FACTOR = 1.62
const BULLET_SPACE_PT = 6
const BULLET_INDENT_PT = 26
const FIT_SAFETY = 0.98

const TITLE_BOX = { y: 0.5, h: 0.85 }
const COVER_TITLE_BOX = { y: 2.35, h: 1.5 }
const COVER_SUBTITLE_BOX = { y: 4.05, h: 0.9 }
const BODY_BOX = { y: 1.8, h: H - 2.6 }

const COVER_TITLE_SIZES = [40, 36, 32, 28, 24] as const
const CONTENT_TITLE_SIZES = [28, 24, 22, 20, 18] as const
const SUBTITLE_SIZES = [18, 16, 14, 12] as const
// 正文最小 14pt：再小就不适合投影，宁可续页也不压到这里（§471 真机验收口径）
const BULLET_SIZES = [17, 15, 14] as const

function charUnits(ch: string): number {
  const cp = ch.codePointAt(0) ?? 32
  if (cp === 32) return 0.3
  return cp < 128 ? 0.55 : 1
}

function textUnits(s: string): number {
  let u = 0
  for (const ch of s) u += charUnits(ch)
  return u
}

function lineCount(text: string, fontSize: number, widthPt: number): number {
  return Math.max(1, Math.ceil((textUnits(text) * fontSize) / widthPt))
}

function truncateToUnits(text: string, maxUnits: number): string {
  let used = 0
  let out = ''
  for (const ch of text) {
    const u = charUnits(ch)
    if (used + u > maxUnits) break
    used += u
    out += ch
  }
  return `${out.replace(/\s+$/, '')}…`
}

interface FittedText {
  text: string
  fontSize: number
}

/** 标题/副标题：从大到小找第一个放得下的字号；都不行就用最小字号 + 按行数截断加省略号 */
function fitText(
  text: string,
  boxW: number,
  boxH: number,
  sizes: readonly number[]
): FittedText {
  const widthPt = boxW * PT - 12
  const maxHeight = boxH * PT * FIT_SAFETY
  for (const fontSize of sizes) {
    if (lineCount(text, fontSize, widthPt) * fontSize * TITLE_LINE_FACTOR <= maxHeight) {
      return { text, fontSize }
    }
  }
  const fontSize = sizes[sizes.length - 1]!
  const maxLines = Math.max(1, Math.floor(maxHeight / (fontSize * TITLE_LINE_FACTOR)))
  const maxUnits = Math.floor((maxLines * widthPt) / fontSize) - 1
  return { text: truncateToUnits(text, maxUnits), fontSize }
}

const BODY_W_PT = (W - MARGIN * 2) * PT - BULLET_INDENT_PT

function bulletHeightIn(text: string, fontSize: number): number {
  return (lineCount(text, fontSize, BODY_W_PT) * fontSize * BODY_LINE_FACTOR + BULLET_SPACE_PT) / PT
}

/** 整页要点能否装进版心：能就给最大可用字号，不能则返回 null（由调用方续页） */
function fitAllBullets(bullets: string[]): number | null {
  const limit = BODY_BOX.h * FIT_SAFETY
  for (const fontSize of BULLET_SIZES) {
    const total = bullets.reduce((sum, b) => sum + bulletHeightIn(b, fontSize), 0)
    if (total <= limit) return fontSize
  }
  return null
}

/** 按给定字号把要点切成若干页（每页高度不超过版心） */
function paginateBullets(bullets: string[], fontSize: number): string[][] {
  const limit = BODY_BOX.h * FIT_SAFETY
  const pages: string[][] = []
  let current: string[] = []
  let used = 0
  for (const b of bullets) {
    const h = bulletHeightIn(b, fontSize)
    if (current.length > 0 && used + h > limit) {
      pages.push(current)
      current = []
      used = 0
    }
    current.push(b)
    used += h
  }
  if (current.length > 0) pages.push(current)
  return pages.length > 0 ? pages : [[]]
}

function addFooter(slide: PptxGenJS.Slide, page: number): void {
  slide.addText(`${page}`, {
    x: W - 1.4,
    y: H - 0.55,
    w: 0.9,
    h: 0.3,
    align: 'right',
    fontFace: THEME.font,
    fontSize: 10,
    color: THEME.muted
  })
}

function addTitleSlide(pptx: PptxGenJS, spec: PptxSpec, page: number): void {
  const slide = pptx.addSlide()
  slide.background = { color: THEME.ink }
  slide.addShape(pptx.ShapeType.rect, {
    x: MARGIN,
    y: 2.1,
    w: 1.1,
    h: 0.09,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 }
  })
  const title = fitText(spec.title, W - MARGIN * 2, COVER_TITLE_BOX.h, COVER_TITLE_SIZES)
  slide.addText(title.text, {
    x: MARGIN,
    y: COVER_TITLE_BOX.y,
    w: W - MARGIN * 2,
    h: COVER_TITLE_BOX.h,
    fontFace: THEME.font,
    fontSize: title.fontSize,
    bold: true,
    color: THEME.white,
    valign: 'top'
  })
  if (spec.subtitle) {
    const sub = fitText(spec.subtitle, W - MARGIN * 2, COVER_SUBTITLE_BOX.h, SUBTITLE_SIZES)
    slide.addText(sub.text, {
      x: MARGIN,
      y: COVER_SUBTITLE_BOX.y,
      w: W - MARGIN * 2,
      h: COVER_SUBTITLE_BOX.h,
      fontFace: THEME.font,
      fontSize: sub.fontSize,
      color: 'D1D5DB',
      valign: 'top'
    })
  }
  addFooter(slide, page)
}

function addContentSlide(
  pptx: PptxGenJS,
  slideSpec: PptxSpec['slides'][number],
  page: number,
  titleText: string,
  bullets?: { items: string[]; fontSize: number }
): void {
  const slide = pptx.addSlide()
  const title = fitText(titleText, W - MARGIN * 2, TITLE_BOX.h, CONTENT_TITLE_SIZES)
  slide.addText(title.text, {
    x: MARGIN,
    y: TITLE_BOX.y,
    w: W - MARGIN * 2,
    h: TITLE_BOX.h,
    fontFace: THEME.font,
    fontSize: title.fontSize,
    bold: true,
    color: THEME.ink,
    valign: 'top'
  })
  slide.addShape(pptx.ShapeType.line, {
    x: MARGIN,
    y: 1.42,
    w: W - MARGIN * 2,
    h: 0,
    line: { color: THEME.line, width: 1 }
  })
  slide.addShape(pptx.ShapeType.rect, {
    x: MARGIN,
    y: 1.4,
    w: 1.2,
    h: 0.055,
    fill: { color: THEME.accent },
    line: { color: THEME.accent, width: 0 }
  })

  if (slideSpec.table) {
    const rows: PptxGenJS.TableRow[] = [
      slideSpec.table.headers.map((h) => ({
        text: h,
        options: {
          bold: true,
          color: THEME.white,
          fill: { color: THEME.accent },
          fontFace: THEME.font,
          fontSize: 13
        }
      })),
      ...slideSpec.table.rows.map((r, ri) =>
        r.map((cell) => ({
          text: cell,
          options: {
            color: THEME.body,
            fill: { color: ri % 2 === 0 ? THEME.white : THEME.zebra },
            fontFace: THEME.font,
            fontSize: 12
          }
        }))
      )
    ]
    const bodyWidth = W - MARGIN * 2
    slide.addTable(rows, {
      x: MARGIN,
      y: 1.75,
      w: bodyWidth,
      colW: Array.from({ length: slideSpec.table.headers.length }, () =>
        bodyWidth / (slideSpec.table?.headers.length ?? 1)
      ),
      border: { type: 'solid', color: THEME.line, pt: 1 },
      valign: 'middle',
      autoPage: false
    })
  } else if (bullets && bullets.items.length > 0) {
    slide.addText(
      bullets.items.map((b) => ({
        text: b,
        options: { bullet: { code: '2022' }, breakLine: true }
      })),
      {
        x: MARGIN,
        y: BODY_BOX.y,
        w: W - MARGIN * 2,
        h: BODY_BOX.h,
        fontFace: THEME.font,
        fontSize: bullets.fontSize,
        color: THEME.body,
        lineSpacingMultiple: 1.35,
        paraSpaceAfter: BULLET_SPACE_PT,
        valign: 'top',
        margin: 0
      }
    )
  }

  if (slideSpec.notes) slide.addNotes(slideSpec.notes)
  addFooter(slide, page)
}

/**
 * 按 spec 生成 .pptx 字节。
 * spec 不合法时抛 `[ARTIFACT_INVALID_SPEC]` 前缀错误（含字段定位），供模型修正后重试。
 */
export async function buildPptx(spec: unknown): Promise<Buffer> {
  const parsed = pptxSpecSchema.safeParse(spec)
  if (!parsed.success) {
    throw new Error(`[ARTIFACT_INVALID_SPEC] ${formatSpecError(parsed.error)}`)
  }
  const data = parsed.data
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'Moxia'
  pptx.company = 'Moxia'
  pptx.subject = data.title
  pptx.title = data.title
  pptx.theme = { headFontFace: THEME.font, bodyFontFace: THEME.font }

  // 页码统一口径：**从封面起连续编号**（封面=1），与 PowerPoint 的「第 N 页」一致
  let page = 0
  addTitleSlide(pptx, data, ++page)

  for (const s of data.slides) {
    if (s.bullets && s.bullets.length > 0) {
      const onePageSize = fitAllBullets(s.bullets)
      const fontSize = onePageSize ?? BULLET_SIZES[BULLET_SIZES.length - 1]!
      const pages = onePageSize ? [s.bullets] : paginateBullets(s.bullets, fontSize)
      pages.forEach((items, pi) => {
        const titleText = pi === 0 ? s.title : `${s.title}（续 ${pi + 1}）`
        addContentSlide(
          pptx,
          pi === 0 ? s : { ...s, notes: undefined },
          ++page,
          titleText,
          { items, fontSize }
        )
      })
    } else {
      addContentSlide(pptx, s, ++page, s.title)
    }
  }

  const out = await pptx.write({ outputType: 'nodebuffer', compression: true })
  if (Buffer.isBuffer(out)) return out
  if (out instanceof Uint8Array) return Buffer.from(out)
  throw new Error('[ARTIFACT_WRITE_FAILED] 生成器返回了非二进制结果')
}
