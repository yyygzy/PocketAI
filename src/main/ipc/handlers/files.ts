// 文件模块 IPC：工作区文件列表/读取/上传/建目录/删除/另存/外部打开
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import { filesService } from '../../files/files-service'

export function registerFileHandlers(): void {
  ipcMain.handle(IPC.FILE_LIST, (_e, relDir: string) => filesService.list(relDir))
  ipcMain.handle(IPC.FILE_READ, (_e, relPath: string) => filesService.read(relPath))
  ipcMain.handle(IPC.FILE_UPLOAD, (_e, relDir: string, name: string, base64: string) =>
    filesService.upload(relDir, name, base64)
  )
  ipcMain.handle(IPC.FILE_MKDIR, (_e, relDir: string, name: string) =>
    filesService.mkdir(relDir, name)
  )
  ipcMain.handle(IPC.FILE_DELETE, (_e, relPath: string) => filesService.remove(relPath))
  ipcMain.handle(IPC.FILE_SAVE_AS, (_e, relPath: string) => filesService.saveAs(relPath))
  ipcMain.handle(IPC.FILE_OPEN_LOCATION, (_e, relPath: string) =>
    filesService.openLocation(relPath)
  )
  ipcMain.handle(IPC.FILE_OPEN_EXTERNAL, (_e, relPath: string) =>
    filesService.openExternal(relPath)
  )
}
