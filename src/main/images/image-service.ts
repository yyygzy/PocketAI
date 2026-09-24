// 绘图主进程服务（V2 批次四）
//
// 职责：
//  - 参数校验（提示词长度 / 模型 / 尺寸白名单）；
//  - 调 OpenAI 兼容适配器的 generateImages（b64 或 url 两种形态）；
//  - 图片落盘 DATA_DIR/images/{yyyy-MM}/{uuid}.png，缩略图缓存 images/.thumbs/{uuid}.jpg；
//  - 成功写历史（v13 images 表），失败/中止不写；
//  - 历史超 200 条滚动删除最旧记录并连带删文件；
//  - 支持用户中止（requestId 维度）与 120s 超时。
import path from 'node:path'
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { nativeImage, dialog } from 'electron'
import { DATA_DIR } from '../portable'
import { providerManager } from '../providers/manager'
import { OpenAICompatibleAdapter } from '../providers/openai-compatible'
import { imageRepo, IMAGE_HISTORY_LIMIT } from '../db/repositories/image.repo'
import { safeFetch } from '../net/safe-fetch'
import { IMAGE_SIZES } from '../../shared/types'
import { errMsg } from '../error'
import type { ImageGeneratePayload, ImageRecord, ImageResult, ImageListItem } from '../../shared/types'
import { imageGenerateSchema } from '../../shared/schemas/images'

const MAX_PROMPT_CHARS = 4000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024 // 单图 20MB 上限
const GENERATE_TIMEOUT_MS = 120_000
const THUMB_WIDTH = 256
const THUMB_QUALITY = 70

/** 进行中的生成请求：requestId → AbortController（用户「停止」用） */
const controllers = new Map<string, AbortController>()

/** 把 DB 存的相对路径解析到 DATA_DIR 内的绝对路径（防库被篡改后穿越） */
export function resolveDataPath(rel: string): string {
  const norm = path.posix.normalize((rel ?? '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '')
  if (norm.includes('\0')) throw new Error('非法路径')
  const abs = path.resolve(DATA_DIR, norm)
  if (abs !== DATA_DIR && !abs.startsWith(DATA_DIR + path.sep)) {
    throw new Error('路径超出数据目录范围')
  }
  return abs
}

/** 由相对文件路径推导缩略图相对路径（images/2026-09/x.png → images/.thumbs/x.jpg） */
export function thumbRelOf(rel: string): string {
  const dir = path.posix.dirname(rel)
  const ext = path.posix.extname(rel)
  const stem = path.posix.basename(rel, ext)
  return `${dir}/.thumbs/${stem}.jpg`
}

function deleteQuiet(abs: string): void {
  try {
    if (fs.existsSync(abs)) fs.rmSync(abs)
  } catch {
    /* 文件被占用/已消失，忽略 */
  }
}

/** 拒绝下载内网/环回地址的图片链接（快速失败给出友好报错；逐跳 SSRF 防护由 safeFetch 统一执行） */
export function isPrivateHostUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return true
    const h = u.hostname.toLowerCase()
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) return true
    if (/^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(h)) return true
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
    if (h === '::1' || h === '[::1]') return true
    return false
  } catch {
    return true
  }
}

/** 落盘一张图片并生成缩略图，返回相对路径与字节数 */
function saveImage(buf: Buffer, ext: string): { rel: string; abs: string; bytes: number } {
  const now = new Date()
  const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  const rel = `images/${monthDir}/${randomUUID()}${ext}`
  const abs = resolveDataPath(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, buf)

  // 缩略图：nativeImage 解码失败（如非标准格式）不阻塞，列表侧返回 null 兜底
  try {
    const img = nativeImage.createFromPath(abs)
    if (!img.isEmpty()) {
      const thumbAbs = resolveDataPath(thumbRelOf(rel))
      fs.mkdirSync(path.dirname(thumbAbs), { recursive: true })
      fs.writeFileSync(thumbAbs, img.resize({ width: THUMB_WIDTH }).toJPEG(THUMB_QUALITY))
    }
  } catch {
    /* 缩略图失败不阻塞主流程 */
  }
  return { rel, abs, bytes: buf.length }
}

/** 历史超限时滚动删除最旧记录（连带删文件与缩略图） */
function pruneHistory(): void {
  const over = imageRepo.count() - IMAGE_HISTORY_LIMIT
  if (over <= 0) return
  for (const old of imageRepo.listOldest(over)) {
    imageRepo.delete(old.id)
    try {
      deleteQuiet(resolveDataPath(old.fileName))
      deleteQuiet(resolveDataPath(thumbRelOf(old.fileName)))
    } catch {
      /* 路径非法时只删记录 */
    }
  }
}

/**
 * 发起一次图像生成。
 * 成功：落盘 + 写历史 + 返回记录；中止/超时/HTTP 错误：不写历史。
 */
export async function runImageGenerate(payload: ImageGeneratePayload): Promise<ImageResult> {
  imageGenerateSchema.parse(payload)
  const started = Date.now()
  const controller = new AbortController()
  controllers.set(payload.requestId, controller)

  try {
    // ---------- 请求形状 + 参数校验 ----------
    if (
      !payload ||
      typeof payload !== 'object' ||
      typeof payload.requestId !== 'string' ||
      typeof payload.providerId !== 'string' ||
      typeof payload.model !== 'string' ||
      typeof payload.prompt !== 'string'
    ) {
      return { ok: false, error: '请求参数不合法' }
    }
    const prompt = String(payload.prompt ?? '').trim()
    if (!prompt) return { ok: false, error: '提示词不能为空' }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `提示词超过 ${MAX_PROMPT_CHARS} 字符上限` }
    }
    const model = String(payload.model ?? '').trim()
    if (!model) return { ok: false, error: '请填写模型名称' }
    const size = String(payload.size ?? '')
    if (!(IMAGE_SIZES as readonly string[]).includes(size)) {
      return { ok: false, error: `不支持的尺寸: ${size}` }
    }

    // ---------- 调适配器 ----------
    const adapter = providerManager.getAdapter(payload.providerId)
    if (!(adapter instanceof OpenAICompatibleAdapter)) {
      return { ok: false, error: '当前 Provider 类型不支持图像生成' }
    }
    // 用户中止与 120s 超时合并为一个信号
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)])
    const result = await adapter.generateImages({ model, prompt, size, signal })
    const provider = providerManager.getRecord(payload.providerId)

    // ---------- 取图：b64 直接解码；url 主进程下载（防渲染端跨域与链接失效） ----------
    let buf: Buffer
    let ext = '.png'
    if (result.b64) {
      if (result.b64.length > (MAX_IMAGE_BYTES / 3) * 4 + 4) {
        return { ok: false, error: '图片超过 20MB 上限' }
      }
      buf = Buffer.from(result.b64, 'base64')
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
        return { ok: false, error: '图片超过 20MB 上限或数据无效' }
      }
    } else if (result.url) {
      if (!/^https?:\/\//i.test(result.url) || isPrivateHostUrl(result.url)) {
        return { ok: false, error: '图片链接不被允许' }
      }
      // safeFetch：逐跳 SSRF 校验（重定向不绕过）、20MB 字节上限、响应外层中止信号
      const res = await safeFetch(result.url, {
        signal,
        timeoutMs: 60_000,
        maxBytes: MAX_IMAGE_BYTES
      })
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `下载图片失败 HTTP ${res.status}` }
      const contentType = (res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
      const allowedMime: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/webp': '.webp',
        'image/gif': '.gif'
      }
      ext = allowedMime[contentType] ?? ''
      if (!ext) return { ok: false, error: `不支持的图片类型: ${contentType || '未知'}` }
      buf = res.body
    } else {
      return { ok: false, error: '响应中没有图片数据' }
    }

    // ---------- 落盘 + 写历史（DB 写失败时回滚已写文件，不留孤儿） ----------
    const saved = saveImage(buf, ext)
    let record: ImageRecord
    try {
      record = imageRepo.add({
        prompt,
        model,
        providerId: payload.providerId,
        providerName: provider.name,
        size,
        fileName: saved.rel,
        bytes: saved.bytes
      })
    } catch (dbErr) {
      deleteQuiet(saved.abs)
      deleteQuiet(resolveDataPath(thumbRelOf(saved.rel)))
      throw dbErr
    }
    pruneHistory()

    return { ok: true, record, durationMs: Date.now() - started }
  } catch (e) {
    if (controller.signal.aborted) return { ok: false, aborted: true, error: '已停止' }
    if (e instanceof Error && e.name === 'TimeoutError') {
      return { ok: false, error: `生成超时（${GENERATE_TIMEOUT_MS / 1000}s），已中止` }
    }
    return { ok: false, error: errMsg(e) }
  } finally {
    controllers.delete(payload.requestId)
  }
}

/** 中止指定生成请求；无对应请求时静默忽略 */
export function abortImageGenerate(requestId: string): void {
  controllers.get(requestId)?.abort()
}

// ---------- 历史与文件操作（IPC 直接调用） ----------

/** 历史列表（附缩略图 dataUrl；缩略图缺失/解码失败为 null） */
export function listImages(): ImageListItem[] {
  return imageRepo.list().map((r) => {
    let thumbDataUrl: string | null = null
    try {
      const thumbAbs = resolveDataPath(thumbRelOf(r.fileName))
      if (fs.existsSync(thumbAbs)) {
        const buf = fs.readFileSync(thumbAbs)
        if (buf.length > 0) thumbDataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
      }
    } catch {
      /* 缩略图读取失败不阻塞列表 */
    }
    return { ...r, thumbDataUrl }
  })
}

/** 读取全图 dataUrl（预览用；≤20MB） */
export function getImageFile(id: string): { ok: boolean; dataUrl?: string; error?: string } {
  try {
    const rec = imageRepo.get(id)
    if (!rec) return { ok: false, error: '记录不存在' }
    const abs = resolveDataPath(rec.fileName)
    if (!fs.existsSync(abs)) return { ok: false, error: '图片文件已不存在' }
    const buf = fs.readFileSync(abs)
    if (buf.length > MAX_IMAGE_BYTES) return { ok: false, error: '图片超过 20MB 上限' }
    const ext = path.extname(abs).toLowerCase()
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'application/octet-stream'
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 删除记录 + 图片文件 + 缩略图（文件缺失不报错） */
export function deleteImage(id: string): { ok: boolean; error?: string } {
  try {
    const rec = imageRepo.get(id)
    if (!rec) return { ok: false, error: '记录不存在' }
    imageRepo.delete(id)
    try {
      deleteQuiet(resolveDataPath(rec.fileName))
      deleteQuiet(resolveDataPath(thumbRelOf(rec.fileName)))
    } catch {
      /* 路径非法时只删记录 */
    }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}

/** 另存为：弹系统保存对话框，把图片复制到用户选择的位置 */
export async function saveImageAs(
  win: Electron.BrowserWindow,
  id: string
): Promise<{ ok: boolean; error?: string }> {
  try {
    const rec = imageRepo.get(id)
    if (!rec) return { ok: false, error: '记录不存在' }
    const abs = resolveDataPath(rec.fileName)
    if (!fs.existsSync(abs)) return { ok: false, error: '图片文件已不存在' }
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.basename(abs)
    })
    if (canceled || !filePath) return { ok: true } // 用户取消不算错误
    fs.copyFileSync(abs, filePath)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: errMsg(e) }
  }
}
