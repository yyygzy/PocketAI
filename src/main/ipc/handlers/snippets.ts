// 提示词片段 IPC
import { IPC } from '../../../shared/types'
import type { PromptSnippetRecord } from '../../../shared/types'
import { snippetRepo } from '../../db/repositories/snippet.repo'
import { safeHandle, argsSchema } from '../safe-handle'
import { snippetCreateSchema, snippetUpdatePatchSchema } from '../../../shared/schemas/snippets'
import { idSchema } from '../../../shared/schemas/providers'

export function registerSnippetHandlers(): void {
  safeHandle(IPC.SNIPPETS_LIST, () => snippetRepo.list())
  safeHandle(
    IPC.SNIPPETS_CREATE,
    (_e, input: { title: string; content: string }) => snippetRepo.create(input),
    argsSchema(snippetCreateSchema)
  )
  safeHandle(
    IPC.SNIPPETS_UPDATE,
    (_e, id: string, patch: Partial<Pick<PromptSnippetRecord, 'title' | 'content'>>) =>
      snippetRepo.update(id, patch ?? {}),
    argsSchema(idSchema, snippetUpdatePatchSchema)
  )
  safeHandle(IPC.SNIPPETS_DELETE, (_e, id: string) => {
    snippetRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))
}
