// 用户记忆（长期记忆）IPC
import { IPC } from '../../../shared/types'
import { userMemoryRepo } from '../../db/repositories/user-memory.repo'
import { safeHandle, argsSchema } from '../safe-handle'
import { memoryContentSchema, memoryIdSchema, memoryIdsSchema } from '../../../shared/schemas/memory'

export function registerMemoryHandlers(): void {
  safeHandle(IPC.MEMORY_LIST, () => userMemoryRepo.list())
  safeHandle(IPC.MEMORY_LIST_DELETED, () => userMemoryRepo.listDeleted())
  safeHandle(
    IPC.MEMORY_ADD,
    (_e, content: string) => userMemoryRepo.add(content),
    argsSchema(memoryContentSchema)
  )
  safeHandle(
    IPC.MEMORY_UPDATE,
    (_e, id: string, content: string) => userMemoryRepo.update(id, content),
    argsSchema(memoryIdSchema, memoryContentSchema)
  )
  safeHandle(IPC.MEMORY_DELETE, (_e, id: string) => {
    userMemoryRepo.remove(id)
    return { ok: true }
  }, argsSchema(memoryIdSchema))
  // 撤销软删除
  safeHandle(IPC.MEMORY_RESTORE, (_e, id: string) => userMemoryRepo.restore(id), argsSchema(memoryIdSchema))
  // 明确的物理清理动作：渲染层已二次确认并说明不可撤回
  safeHandle(
    IPC.MEMORY_PURGE,
    (_e, ids: string[]) => ({ ok: true, deleted: userMemoryRepo.purgeMany(ids) }),
    argsSchema(memoryIdsSchema)
  )
}
