// AI 绘图 IPC：生成/中止/图库/另存
import { BrowserWindow } from 'electron'
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
import { safeHandle, argsSchema, z } from '../safe-handle'
import { imageGenerateSchema } from '../../../shared/schemas/images'
import { idSchema } from '../../../shared/schemas/providers'

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
}
