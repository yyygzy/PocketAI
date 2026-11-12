// 多文件项目 IPC：预览 / 撤销 / 导出 ZIP
//
// 打开所在文件夹、另存 ZIP **不新增通道**：目录与 zip 都在 DATA_DIR/generated/projects/ 下，
// 直接复用 file:open-location / file:save-as（relPath 由 ProjectMeta / 导出结果给出）。
import { IPC } from '../../../shared/types'
import type { ProjectPreview } from '../../../shared/types'
import { deleteProject, exportProjectZip, getProjectPreview } from '../../projects/project-service'
import type { ProjectFailure, ProjectUndoSuccess, ProjectZipSuccess } from '../../projects/project-service'
import { safeHandle, argsSchema } from '../safe-handle'
import { projectIdSchema } from '../../../shared/schemas/projects'

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
}
