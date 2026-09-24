// 用户记忆（长期记忆）IPC
import { IPC } from '../../../shared/types'
import { userMemoryRepo } from '../../db/repositories/user-memory.repo'
import { safeHandle, argsSchema } from '../safe-handle'
import { memoryContentSchema, memoryIdSchema } from '../../../shared/schemas/memory'

export function registerMemoryHandlers(): void {
  safeHandle(IPC.MEMORY_LIST, () => userMemoryRepo.list())
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
}
