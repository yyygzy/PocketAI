// 模型 Provider 管理 IPC
import { ipcMain } from 'electron'
import { IPC } from '../../../shared/types'
import type { ProviderRecord } from '../../../shared/types'
import { providerRepo } from '../../db/repositories/provider.repo'
import { providerManager } from '../../providers/manager'

export function registerProviderHandlers(): void {
  ipcMain.handle(IPC.PROVIDER_LIST, () => providerRepo.list())

  ipcMain.handle(IPC.PROVIDER_SAVE, (_e, record: ProviderRecord) => {
    const saved = providerRepo.save(record)
    providerManager.invalidate(saved.id)
    return saved
  })

  ipcMain.handle(IPC.PROVIDER_DELETE, (_e, id: string) => {
    providerRepo.delete(id)
    providerManager.invalidate(id)
    return { ok: true }
  })

  ipcMain.handle(IPC.PROVIDER_FETCH_MODELS, (_e, id: string) =>
    providerManager.fetchModels(id)
  )
  ipcMain.handle(IPC.PROVIDER_TEST, (_e, id: string) => providerManager.test(id))
}
