// 多文件项目 IPC：预览 / 撤销 / 导出 ZIP；工作目录项目：打开所在目录 / 按绝对路径导出 ZIP
//
// 两套目标形态的区别：
//  · 应用目录项目（projects 表有行）→ 目录与 zip 都在 DATA_DIR/generated/projects/ 下，
//    直接复用 file:open-location / file:save-as（relPath 由 ProjectMeta / 导出结果给出）；
//  · 工作目录项目（无表行）→ 只有绝对路径。**绝对路径一律由主进程重新 realpath 校验**
//    落在 Agent 工作目录内才允许打开/打包，渲染层传来的值一律不信任。
import { BrowserWindow, dialog, shell } from 'electron'
import { IPC } from '../../../shared/types'
import type { ProjectOpenDirResult, ProjectPreview, ProjectZipAbsResult } from '../../../shared/types'
import { deleteProject, exportProjectZip, getProjectPreview, zipDirToFile } from '../../projects/project-service'
import type { ProjectFailure, ProjectUndoSuccess, ProjectZipSuccess } from '../../projects/project-service'
import { resolveWorkspaceAbsDir } from '../../projects/project-target'
import { safeHandle, argsSchema } from '../safe-handle'
import { projectAbsDirSchema, projectIdSchema } from '../../../shared/schemas/projects'

/**
 * 把 resolveWorkspaceAbsDir 的失败转成 `CODE:说明` 抛出。
 * 回码必须写成**字面量**：`${dir.code}:` 拼出来的串扫不到 §206 的回码对账闸门，
 * 界面也换不成四语（那道闸门要求每个回码都能在 main 里被看见）。
 */
function throwDirFailure(dir: { code: string; message: string }): never {
  if (dir.code === 'PROJECT_DIR_MISSING') throw new Error(`PROJECT_DIR_MISSING:${dir.message}`)
  if (dir.code === 'PROJECT_TARGET_NO_WORKSPACE') {
    throw new Error(`PROJECT_TARGET_NO_WORKSPACE:${dir.message}`)
  }
  throw new Error(`PROJECT_OPEN_DIR_DENIED:${dir.message}`)
}

export function registerProjectHandlers(): void {
  safeHandle(
    IPC.PROJECT_PREVIEW,
    (_e, id: string): ProjectPreview | null => getProjectPreview(id),
    argsSchema(projectIdSchema)
  )
  safeHandle(
    IPC.PROJECT_DELETE,
    (_e, id: string): ProjectUndoSuccess | ProjectFailure => deleteProject(id),
    argsSchema(projectIdSchema)
  )
  safeHandle(
    IPC.PROJECT_EXPORT_ZIP,
    (_e, id: string): Promise<ProjectZipSuccess | ProjectFailure> => exportProjectZip(id),
    argsSchema(projectIdSchema)
  )

  // 工作目录项目：打开所在目录（绝对路径由主进程重新校验；失败抛 `CODE:说明` 走 safeHandle）
  safeHandle(
    IPC.PROJECT_OPEN_DIR,
    async (_e, absPath: string): Promise<ProjectOpenDirResult> => {
      const dir = resolveWorkspaceAbsDir(absPath)
      if (!dir.ok) throwDirFailure(dir)
      const failure = await shell.openPath(dir.abs)
      if (failure) throw new Error(`PROJECT_OPEN_DIR_DENIED:系统拒绝打开：${failure}`)
      return { ok: true, path: dir.abs }
    },
    argsSchema(projectAbsDirSchema)
  )

  // 工作目录项目：打包 + 保存框。取消返回 {ok:true,canceled:true}，不是错误
  safeHandle(
    IPC.PROJECT_EXPORT_ZIP_ABS,
    async (e, absPath: string): Promise<ProjectZipAbsResult> => {
      const dir = resolveWorkspaceAbsDir(absPath)
      if (!dir.ok) throwDirFailure(dir)
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) throw new Error('PROJECT_EXPORT_FAILED:窗口不可用')
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: `${dir.name}.zip`,
        filters: [
          { name: 'ZIP', extensions: ['zip'] },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (canceled || !filePath) return { ok: true, canceled: true }
      const res = await zipDirToFile(dir.abs, filePath)
      if (!res.ok) throw new Error(`PROJECT_EXPORT_FAILED:${res.message}`)
      return { ok: true, path: filePath }
    },
    argsSchema(projectAbsDirSchema)
  )
}
