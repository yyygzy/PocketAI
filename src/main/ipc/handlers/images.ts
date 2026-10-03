// AI 绘图 IPC：生成/中止/图库/另存 + 灯箱图片 data URL 通用复制/另存
import { BrowserWindow, clipboard, ClipboardItem, dialog, nativeImage } from 'electron'
import fs from 'node:fs/promises'
import { IPC } from '../../../shared/types'
import type { ImageGeneratePayload } from '../../../shared/types'
import {
  runImageGenerate,
  abortImageGenerate,
  listImages,
  getImageFile,
  deleteImage,
  saveImageAs
} from '../../images/image-service'
import { parseImageDataUrl, defaultImageFileName } from '../../images/data-url'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { imageGenerateSchema } from '../../../shared/schemas/images'
import { idSchema } from '../../../shared/schemas/providers'

/** 灯箱 data URL 入参（整体长度硬上限在 zod 层先挡一道，解析层再做 MIME/字节精校） */
const dataUrlImageSchema = z.object({
  dataUrl: z.string().min(1).max(16 * 1024 * 1024),
  defaultName: z.string().max(200).optional()
})

export function registerImageHandlers(): void {
  safeHandle(IPC.IMAGES_GENERATE, async (_e, payload: ImageGeneratePayload) => {
    return runImageGenerate(payload)
  }, argsSchema(imageGenerateSchema))
  safeHandle(IPC.IMAGES_ABORT, (_e, requestId: string) => {
    abortImageGenerate(String(requestId ?? ''))
    return { ok: true }
  }, argsSchema(z.string()))
  safeHandle(IPC.IMAGES_LIST, () => listImages())
  safeHandle(IPC.IMAGES_GET_FILE, (_e, id: string) => getImageFile(String(id ?? '')), argsSchema(idSchema))
  safeHandle(IPC.IMAGES_DELETE, (_e, id: string) => deleteImage(String(id ?? '')), argsSchema(idSchema))
  safeHandle(IPC.IMAGES_SAVE_AS, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return saveImageAs(win!, String(id ?? ''))
  }, argsSchema(idSchema))

  // 灯箱：复制图片到系统剪贴板（Electron 44 clipboard 为异步 W3C API；统一转 PNG 兼容性最好）
  safeHandle(IPC.CLIPBOARD_WRITE_IMAGE, async (_e, arg: z.infer<typeof dataUrlImageSchema>) => {
    const parsed = parseImageDataUrl(arg.dataUrl)
    const img = nativeImage.createFromBuffer(parsed.buffer)
    if (img.isEmpty()) throw new Error('图片解码失败')
    // Buffer 底层可能是 SharedArrayBuffer，不符合 BlobPart；拷一份独立 ArrayBuffer
    const png = img.toPNG()
    const ab = new ArrayBuffer(png.byteLength)
    new Uint8Array(ab).set(png)
    const blob = new Blob([ab], { type: 'image/png' })
    await clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return { ok: true as const }
  }, argsSchema(dataUrlImageSchema))

  // 灯箱：图片另存为（路径由系统 save dialog 给出，渲染端只提供默认文件名）
  safeHandle(IPC.IMAGE_SAVE_DATAURL, async (e, arg: z.infer<typeof dataUrlImageSchema>) => {
    const parsed = parseImageDataUrl(arg.dataUrl)
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    const { canceled, filePath } = await dialog.showSaveDialog(win!, {
      title: '保存图片',
      defaultPath: defaultImageFileName(arg.defaultName, parsed.ext),
      filters: [
        { name: '图片', extensions: [parsed.ext] },
        { name: 'PNG', extensions: ['png'] },
        { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
        { name: 'WebP', extensions: ['webp'] },
        { name: 'GIF', extensions: ['gif'] },
        { name: 'BMP', extensions: ['bmp'] }
      ]
    })
    if (canceled || !filePath) return { canceled: true as const }
    await fs.writeFile(filePath, parsed.buffer)
    return { path: filePath }
  }, argsSchema(dataUrlImageSchema))
}
