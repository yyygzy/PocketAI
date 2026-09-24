// 自建助手 IPC（含免费版数量门控）
import { IPC } from '../../../shared/types'
import type { AssistantRecord } from '../../../shared/types'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { assertCanCreateAssistant } from '../../license/license'
import { safeHandle, argsSchema } from '../safe-handle'
import { assistantSaveSchema, booleanSchema } from '../../../shared/schemas/assistants'
import { idSchema } from '../../../shared/schemas/providers'

export function registerAssistantHandlers(): void {
  safeHandle(IPC.ASSISTANT_LIST, () => assistantRepo.list())
  safeHandle(IPC.ASSISTANT_GET, (_e, id: string) => assistantRepo.get(id), argsSchema(idSchema))
  safeHandle(IPC.ASSISTANT_SAVE, (_e, record: Partial<AssistantRecord> & { name: string }) => {
    // License 门控：免费版限制自建助手数量（新建/复制场景；内置助手不计）
    if (!record.id || !assistantRepo.get(record.id)) {
      assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    }
    return assistantRepo.save(record)
  }, argsSchema(assistantSaveSchema))
  safeHandle(IPC.ASSISTANT_DELETE, (_e, id: string) => {
    assistantRepo.delete(id)
    return { ok: true }
  }, argsSchema(idSchema))
  safeHandle(IPC.ASSISTANT_DUPLICATE, (_e, id: string) => {
    assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    return assistantRepo.duplicate(id)
  }, argsSchema(idSchema))
  safeHandle(IPC.ASSISTANT_SET_PINNED, (_e, id: string, pinned: boolean) => {
    assistantRepo.setPinned(id, pinned)
    return { ok: true }
  }, argsSchema(idSchema, booleanSchema))
}
