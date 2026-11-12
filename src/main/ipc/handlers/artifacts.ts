// 成品文件 IPC：列表 / 预览 / 删除
//
// 另存为、打开、打开所在目录**不新增通道**：产物落在 DATA_DIR/generated/ 下，
// 直接复用文件模块的 file:save-as / file:open-external / file:open-location（relPath 由 ArtifactMeta 给出），
// 这样失败语义（§332 openPath 返回错误串也要报错）不用再写一遍。
import { IPC } from '../../../shared/types'
import type { ArtifactMeta, ArtifactPreview } from '../../../shared/types'
import { deleteArtifact, listArtifacts } from '../../artifacts/artifact-service'
import { buildArtifactPreview } from '../../artifacts/artifact-preview'
import { safeHandle, argsSchema } from '../safe-handle'
import { artifactConversationIdSchema, artifactIdSchema } from '../../../shared/schemas/artifacts'

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
}
