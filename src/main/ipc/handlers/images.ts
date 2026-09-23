// AI 绘图 IPC：生成/中止/图库/另存
import { ipcMain, BrowserWindow } from 'electron'
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

export function registerImageHandlers(): void {
  ipcMain.handle(IPC.IMAGES_GENERATE, async (_e, payload: ImageGeneratePayload) => {
    return runImageGenerate(payload)
  })
  ipcMain.handle(IPC.IMAGES_ABORT, (_e, requestId: string) => {
    abortImageGenerate(String(requestId ?? ''))
    return { ok: true }
  })
  ipcMain.handle(IPC.IMAGES_LIST, () => listImages())
  ipcMain.handle(IPC.IMAGES_GET_FILE, (_e, id: string) => getImageFile(String(id ?? '')))
  ipcMain.handle(IPC.IMAGES_DELETE, (_e, id: string) => deleteImage(String(id ?? '')))
  ipcMain.handle(IPC.IMAGES_SAVE_AS, async (e, id: string) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0]
    return saveImageAs(win!, String(id ?? ''))
  })
}
