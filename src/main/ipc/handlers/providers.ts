// 模型 Provider 管理 IPC
import { IPC } from '../../../shared/types'
import type { ProviderRecord } from '../../../shared/types'
import { providerRepo } from '../../db/repositories/provider.repo'
import { providerManager } from '../../providers/manager'
import { safeHandle, argsSchema } from '../safe-handle'
import { providerRecordSchema, idSchema } from '../../../shared/schemas/providers'

export function registerProviderHandlers(): void {
  safeHandle(IPC.PROVIDER_LIST, () => providerRepo.list())

  safeHandle(IPC.PROVIDER_SAVE, (_e, record: ProviderRecord) => {
    const saved = providerRepo.save(record)
    providerManager.invalidate(saved.id)
    return saved
  }, argsSchema(providerRecordSchema))

  safeHandle(IPC.PROVIDER_DELETE, (_e, id: string) => {
    providerRepo.delete(id)
    providerManager.invalidate(id)
    return { ok: true }
  }, argsSchema(idSchema))

  safeHandle(IPC.PROVIDER_FETCH_MODELS, (_e, id: string) =>
    providerManager.fetchModels(id),
  argsSchema(idSchema))
  safeHandle(IPC.PROVIDER_TEST, (_e, id: string) => providerManager.test(id), argsSchema(idSchema))
}
