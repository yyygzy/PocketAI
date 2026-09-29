// 图片 OCR：用知识库配置的视觉模型（provider 体系 image_url 多模态）识别图片中的文字，
// 识别结果作为纯文本走常规 分块 → 向量化 → 入库 链路。
// 与 multi-query.ts 同模式：失败抛错由调用方（ingestion）落文档 error，不中断队列。
// 纯函数（imageMime）单独导出供 tests/ocr.test.ts 直测。
import fs from 'node:fs'
import path from 'node:path'
import { providerManager } from '../providers/manager'

const OCR_SYSTEM_PROMPT = `你是 OCR 文字识别助手。提取图片中出现的全部文字内容，要求：
- 保持原有的阅读顺序与段落结构，输出为纯文本（Markdown）
- 表格转 Markdown 表格；公式用 LaTeX 表示
- 只输出识别到的文字，不要解释、不要添加图片中不存在的内容`

/** 单张图片上限：base64 后约 13MB 请求体，主流视觉 API 限额内 */
export const OCR_MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** 图片扩展名 → MIME（data URL 用）；未知扩展返回 null */
export function imageMime(ext: string): string | null {
  switch (ext.toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return null
  }
}

/**
 * 识别图片文件中的文字。
 * 失败（无 adapter/超限/读取失败/模型报错/空结果）抛错，由调用方定语义。
 */
export async function ocrImageFile(
  filePath: string,
  providerId: string,
  model: string
): Promise<string> {
  const mime = imageMime(path.extname(filePath))
  if (!mime) throw new Error(`不支持的图片格式: ${path.basename(filePath)}`)

  let stat: fs.Stats
  try {
    stat = fs.statSync(filePath)
  } catch {
    throw new Error(`图片文件不存在或不可读: ${path.basename(filePath)}`)
  }
  if (stat.size > OCR_MAX_IMAGE_BYTES) {
    throw new Error(`图片超过 ${Math.round(OCR_MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限: ${path.basename(filePath)}`)
  }

  const adapter = providerManager.getAdapter(providerId)
  if (!adapter) throw new Error(`OCR provider 不可用: ${providerId}`)

  const dataUrl = `data:${mime};base64,${fs.readFileSync(filePath).toString('base64')}`
  const result = await adapter.streamChat(
    [
      { role: 'system', content: OCR_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: '识别这张图片中的全部文字' },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    { model, temperature: 0, maxTokens: 4096 },
    { onDelta: () => {} }
  )
  const text = result.content.trim()
  if (!text) throw new Error(`图片未识别到文字: ${path.basename(filePath)}`)
  return text
}
