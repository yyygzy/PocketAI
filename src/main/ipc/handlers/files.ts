// 文件模块 IPC：工作区文件列表/读取/上传/建目录/删除/另存/外部打开
import { IPC } from '../../../shared/types'
import { filesService } from '../../files/files-service'
import { safeHandle, argsSchema } from '../safe-handle'
import { safeRelPath, safeRelDir, safeFileName, base64Content } from '../../../shared/schemas/files'

export function registerFileHandlers(): void {
  // 目录类接口（可传空字符串表示根目录）用 safeRelDir；
  // 文件类接口（必须指向具体条目）用 safeRelPath
  safeHandle(IPC.FILE_LIST, (_e, relDir: string) => filesService.list(relDir), argsSchema(safeRelDir))
  safeHandle(IPC.FILE_READ, (_e, relPath: string) => filesService.read(relPath), argsSchema(safeRelPath))
  safeHandle(
    IPC.FILE_UPLOAD,
    (_e, relDir: string, name: string, base64: string) => filesService.upload(relDir, name, base64),
    argsSchema(safeRelDir, safeFileName, base64Content)
  )
  safeHandle(
    IPC.FILE_MKDIR,
    (_e, relDir: string, name: string) => filesService.mkdir(relDir, name),
    argsSchema(safeRelDir, safeFileName)
  )
  safeHandle(IPC.FILE_DELETE, (_e, relPath: string) => filesService.remove(relPath), argsSchema(safeRelPath))
  safeHandle(IPC.FILE_SAVE_AS, (_e, relPath: string) => filesService.saveAs(relPath), argsSchema(safeRelPath))
  safeHandle(
    IPC.FILE_OPEN_LOCATION,
    (_e, relPath: string) => filesService.openLocation(relPath),
    argsSchema(safeRelDir)
  )
  safeHandle(
    IPC.FILE_OPEN_EXTERNAL,
    (_e, relPath: string) => filesService.openExternal(relPath),
    argsSchema(safeRelPath)
  )
}
