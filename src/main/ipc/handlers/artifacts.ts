// 成品文件 IPC：列表 / 预览 / 删除 / 读全文 / 导出 PDF
//
// 另存为、打开、打开所在目录**不新增通道**：产物落在 DATA_DIR/generated/ 下，
// 直接复用文件模块的 file:save-as / file:open-external / file:open-location（relPath 由 ArtifactMeta 给出），
// 这样失败语义（§332 openPath 返回错误串也要报错）不用再写一遍。
//
// 导出 PDF 是例外：PDF 不落 generated/、不入库，目标路径由用户在选择框里定，
// 所以必须自己开一条通道（见 artifact-pdf-export.ts）。
import { BrowserWindow } from 'electron'
import { IPC } from '../../../shared/types'
import type { ArtifactMeta, ArtifactPdfExportResult, ArtifactPreview, ArtifactTextResult } from '../../../shared/types'
import { deleteArtifact, listArtifacts, readArtifactText } from '../../artifacts/artifact-service'
import { buildArtifactPreview } from '../../artifacts/artifact-preview'
import { exportArtifactPdf } from '../../artifacts/artifact-pdf-export'
import { safeHandle, argsSchema } from '../safe-handle'
import {
  artifactConversationIdSchema,
  artifactIdSchema,
  artifactPdfHtmlSchema
} from '../../../shared/schemas/artifacts'

export function registerArtifactHandlers(): void {
  safeHandle(
    IPC.ARTIFACT_LIST,
    (_e, conversationId?: string | null): ArtifactMeta[] => listArtifacts(conversationId ?? null),
    argsSchema(artifactConversationIdSchema)
  )
  safeHandle(
    IPC.ARTIFACT_PREVIEW,
    (_e, id: string): Promise<ArtifactPreview | null> => buildArtifactPreview(id),
    argsSchema(artifactIdSchema)
  )
  safeHandle(
    IPC.ARTIFACT_DELETE,
    (_e, id: string): { ok: boolean } => ({ ok: deleteArtifact(id) }),
    argsSchema(artifactIdSchema)
  )
  safeHandle(
    IPC.ARTIFACT_READ_TEXT,
    (_e, id: string): ArtifactTextResult => readArtifactText(id),
    argsSchema(artifactIdSchema)
  )
  safeHandle(
    IPC.ARTIFACT_EXPORT_PDF,
    (e, id: string, html: string): Promise<ArtifactPdfExportResult> => {
      const win = BrowserWindow.fromWebContents(e.sender) ?? BrowserWindow.getAllWindows()[0] ?? null
      return exportArtifactPdf({ win, id, html })
    },
    argsSchema(artifactIdSchema, artifactPdfHtmlSchema)
  )
}
