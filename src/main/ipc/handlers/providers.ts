// 模型 Provider 管理 IPC
//
// 凭据收口：列表/保存返回一律掩码（apiKeys 只回 ••••+末 4 位），渲染层注入也拿不到明文；
// 需要查看/复制时由用户显式点「显示密钥」走 PROVIDER_REVEAL_KEYS（单条、可审计、受锁网关约束）。
// 保存路径的占位回填见 providerRepo.save。
import { IPC } from '../../../shared/types'
import type { ProviderRecord } from '../../../shared/types'
import { providerRepo } from '../../db/repositories/provider.repo'
import { providerManager } from '../../providers/manager'
import { safeHandle, argsSchema } from '../safe-handle'
import { providerRecordSchema, idSchema } from '../../../shared/schemas/providers'
import { maskSecretList } from '../../../shared/secret-mask'

/** 出 IPC 前把 apiKeys 换成掩码视图 */
function maskProvider(rec: ProviderRecord): ProviderRecord {
  return { ...rec, apiKeys: maskSecretList(rec.apiKeys) }
}

export function registerProviderHandlers(): void {
  safeHandle(IPC.PROVIDER_LIST, () => providerRepo.list().map(maskProvider))

  safeHandle(IPC.PROVIDER_SAVE, (_e, record: ProviderRecord) => {
    const saved = providerRepo.save(record)
    providerManager.invalidate(saved.id)
    return maskProvider(saved)
  }, argsSchema(providerRecordSchema))

  // 显式揭示单个 Provider 的真实密钥（仅编辑场景按需调用）
  safeHandle(IPC.PROVIDER_REVEAL_KEYS, (_e, id: string) => {
    const rec = providerRepo.get(id)
    return { ok: true as const, apiKeys: rec?.apiKeys ?? [] }
  }, argsSchema(idSchema))

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
