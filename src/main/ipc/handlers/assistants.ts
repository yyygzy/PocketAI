// 自建助手 IPC（含免费版数量门控）
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import type { AssistantRecord } from '../../../shared/types'
import { assistantRepo } from '../../db/repositories/assistant.repo'
import { assertCanCreateAssistant } from '../../license/license'

export function registerAssistantHandlers(): void {
  ipcMain.handle(IPC.ASSISTANT_LIST, () => assistantRepo.list())
  ipcMain.handle(IPC.ASSISTANT_GET, (_e, id: string) => assistantRepo.get(id))
  ipcMain.handle(IPC.ASSISTANT_SAVE, (_e, record: Partial<AssistantRecord> & { name: string }) => {
    // License 门控：免费版限制自建助手数量（新建/复制场景；内置助手不计）
    if (!record.id || !assistantRepo.get(record.id)) {
      assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    }
    return assistantRepo.save(record)
  })
  ipcMain.handle(IPC.ASSISTANT_DELETE, (_e, id: string) => {
    assistantRepo.delete(id)
    return { ok: true }
  })
  ipcMain.handle(IPC.ASSISTANT_DUPLICATE, (_e, id: string) => {
    assertCanCreateAssistant(assistantRepo.list().filter((a) => !a.isBuiltin).length)
    return assistantRepo.duplicate(id)
  })
  ipcMain.handle(IPC.ASSISTANT_SET_PINNED, (_e, id: string, pinned: boolean) => {
    assistantRepo.setPinned(id, pinned)
    return { ok: true }
  })
}
