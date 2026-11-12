// 产物预览：md 给正文；pptx 只提取**文字大纲**（不还原版式）；docx 用 mammoth 转只读 HTML
//
// 为什么不做 pptx 视觉预览：离线产品里没有可靠的纯 JS pptx 渲染器，LibreOffice/Office 又不能随包。
// 与其画一张假的"预览图"，不如老实给大纲，并在界面文案里写明"不还原版式"。
// docx 的 HTML 由 mammoth 从 document.xml 转出：**仅供无脚本沙箱 iframe 渲染**，
// 渲染端不许把它直接注入主文档（见 ArtifactActions）。
import { Open } from 'unzipper'
import mammoth from 'mammoth'
import { getArtifact, readArtifact } from './artifact-service'
import type { ArtifactMeta, ArtifactPreview } from '../../shared/types'

const MAX_MD_CHARS = 200_000
const MAX_SLIDES = 60
const MAX_LINES_PER_SLIDE = 12
const MAX_LINE_CHARS = 200
/** docx 预览 HTML 上限：再长也没人会在卡片里读完，截断并如实标注 */
const MAX_DOCX_HTML_CHARS = 300_000

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => {
      const code = Number.parseInt(hex, 16)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&#(\d+);/g, (_, dec: string) => {
      const code = Number.parseInt(dec, 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : ''
    })
    .replace(/&amp;/g, '&')
}

function slideIndex(filePath: string): number {
  const n = /slide(\d+)\.xml$/.exec(filePath)?.[1]
  return n ? Number.parseInt(n, 10) : Number.MAX_SAFE_INTEGER
}

/** 从 slideN.xml 里按出现顺序取文字；剔除页脚页码（末尾的 1~3 位纯数字） */
function extractSlideText(xml: string): { title: string; lines: string[] } {
  const texts = [...xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
    .map((m) => decodeXmlEntities(m[1] ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const last = texts[texts.length - 1]
  if (last && /^\d{1,3}$/.test(last)) texts.pop()
  const title = (texts[0] ?? '').slice(0, MAX_LINE_CHARS)
  const lines = texts.slice(1, 1 + MAX_LINES_PER_SLIDE).map((t) => t.slice(0, MAX_LINE_CHARS))
  return { title, lines }
}

async function readPptxOutline(meta: ArtifactMeta): Promise<ArtifactPreview> {
  const bytes = readArtifact(meta.id)?.bytes
  if (!bytes) return { id: meta.id, kind: 'pptx', missing: true }
  try {
    const dir = await Open.buffer(bytes)
    const slideFiles = dir.files
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f.path))
      .sort((a, b) => slideIndex(a.path) - slideIndex(b.path))
      .slice(0, MAX_SLIDES)
    const slides: Array<{ title: string; lines: string[] }> = []
    for (const f of slideFiles) {
      slides.push(extractSlideText((await f.buffer()).toString('utf8')))
    }
    return { id: meta.id, kind: 'pptx', missing: false, slides }
  } catch {
    // 包损坏/被占用：如实给空大纲，不假装成功
    return { id: meta.id, kind: 'pptx', missing: false, slides: [] }
  }
}

async function readDocxHtml(meta: ArtifactMeta): Promise<ArtifactPreview> {
  const bytes = readArtifact(meta.id)?.bytes
  if (!bytes) return { id: meta.id, kind: 'docx', missing: true }
  try {
    const { value } = await mammoth.convertToHtml({ buffer: bytes })
    const truncated = value.length > MAX_DOCX_HTML_CHARS
    return {
      id: meta.id,
      kind: 'docx',
      missing: false,
      html: truncated ? value.slice(0, MAX_DOCX_HTML_CHARS) : value,
      ...(truncated ? { truncated: true } : {})
    }
  } catch {
    // 包损坏/被占用：html 给空串，界面如实说"渲染失败"，不假装预览成功
    return { id: meta.id, kind: 'docx', missing: false, html: '' }
  }
}

export async function buildArtifactPreview(id: string): Promise<ArtifactPreview | null> {
  const meta = getArtifact(id)
  if (!meta) return null
  if (meta.kind === 'pptx') return readPptxOutline(meta)
  if (meta.kind === 'docx') return readDocxHtml(meta)

  const read = readArtifact(meta.id)
  if (!read) return { id: meta.id, kind: 'md', missing: true }
  const text = read.bytes.toString('utf8')
  const truncated = text.length > MAX_MD_CHARS
  return {
    id: meta.id,
    kind: 'md',
    missing: false,
    markdown: truncated ? text.slice(0, MAX_MD_CHARS) : text,
    ...(truncated ? { truncated: true } : {})
  }
}
