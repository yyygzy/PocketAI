// 图片 data URL 解析（纯 node，可单测）：灯箱复制到剪贴板 / 另存为共用。
// 渲染端附件 data URL 经 IPC 传入主进程，必须在 nativeImage/fs 之前做强校验，
// 防非法前缀与超大 base64 灌内存。
import path from 'node:path'

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp'
}

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|jpg|webp|gif|bmp));base64,([A-Za-z0-9+/=\s]+)$/

export interface ParsedImageDataUrl {
  mime: string
  ext: string
  buffer: Buffer
}

/**
 * 解析并校验图片 data URL。
 * @param maxBytes 解码后字节数上限（默认 12MB，与图片附件 10MB 量级对齐留余量）
 * @throws 前缀非法 / base64 非法 / 超限时抛错（错误信息中文，可直接回传渲染端）
 */
export function parseImageDataUrl(dataUrl: string, maxBytes: number = 12 * 1024 * 1024): ParsedImageDataUrl {
  if (typeof dataUrl !== 'string' || dataUrl.length === 0) throw new Error('图片数据为空')
  const m = DATA_URL_RE.exec(dataUrl)
  if (!m) throw new Error('仅支持 PNG / JPEG / WebP / GIF / BMP 的 base64 图片')
  const mime = m[1]!
  const b64 = m[2]!.replace(/\s/g, '')
  // 粗检：base64 长度 ≈ 字节数 * 4/3，先挡明显超限（避免分配超大 Buffer）
  if (b64.length > Math.ceil(maxBytes * 1.4) + 64) throw new Error('图片过大（上限 12MB）')
  const buffer = Buffer.from(b64, 'base64')
  if (buffer.length === 0) throw new Error('图片内容为空')
  if (buffer.length > maxBytes) throw new Error('图片过大（上限 12MB）')
  return { mime, ext: MIME_TO_EXT[mime] ?? 'png', buffer }
}

/** 另存默认文件名：无扩展名时按 mime 补；去路径分隔防目录穿越（dialog 另给路径，但文件名会拼进默认值） */
export function defaultImageFileName(name: string | undefined, ext: string): string {
  const base = (name ?? '').trim() || 'image'
  const cleaned =
    base
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\.{2,}/g, '_') // 连续点（../ 残留）折成下划线，单个扩展名点保留
      .slice(0, 120) || 'image'
  return path.extname(cleaned) ? cleaned : `${cleaned}.${ext}`
}
