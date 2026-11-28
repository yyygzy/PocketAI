// 模型 Provider 管理 IPC
//
// 凭据收口：列表/保存返回一律掩码（apiKeys 只回 ••••+末 4 位），渲染层注入也拿不到明文；
// 需要查看/复制时由用户显式点「显示密钥」走 PROVIDER_REVEAL_KEYS（单条、受锁网关约束）。
// SEC-16-11：reveal 通道补「审计 + 冷却 + 单次令牌」三件套——
// - 每次成功 reveal 前写一条 credential_reveal 审计（security_events，不含密钥值）；
// - 同一 providerId 60s 冷却，压住批量遍历导出的速率；
// - reveal 必须携带 PROVIDER_REQUEST_REVEAL_TOKEN 签发的一次性令牌（用后即焚）。
// 令牌由渲染层可自行调用的 IPC 签发，不是主防线（见 credential-reveal.ts 文件头）。
import { IPC } from '../../../shared/types'
import type { ProviderRecord } from '../../../shared/types'
import { providerRepo } from '../../db/repositories/provider.repo'
import { securityEventRepo } from '../../db/repositories/security-event.repo'
import { providerManager } from '../../providers/manager'
import { safeHandle, argsSchema, z } from '../safe-handle'
import { providerRecordSchema, idSchema } from '../../../shared/schemas/providers'
import { maskSecretList } from '../../../shared/secret-mask'
import {
  issueRevealToken,
  consumeRevealToken,
  revealCooldownOk,
  markRevealDone,
  CREDENTIAL_REVEAL_KIND
} from '../credential-reveal'

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

  // SEC-16-11：签发一次性 reveal 令牌（无业务副作用；锁屏期间被网关 fail-closed 拦截）
  safeHandle(IPC.PROVIDER_REQUEST_REVEAL_TOKEN, () => ({
    ok: true as const,
    token: issueRevealToken('provider')
  }))

  // 显式揭示单个 Provider 的真实密钥（仅编辑场景按需调用）
  // 顺序：冷却闸 → 令牌消费（先焚后验，失败重放不了）→ 审计留痕 → 取值。
  // 审计只记「谁被揭示」，message/detail 都不含密钥值；append 失败不阻断（repo 的 fail-open 口径）。
  safeHandle(IPC.PROVIDER_REVEAL_KEYS, (_e, id: string, token: string) => {
    if (!revealCooldownOk('provider', id)) {
      return { ok: false as const, error: '操作过于频繁：同一服务商的密钥揭示有 60 秒冷却，请稍后再试' }
    }
    if (!consumeRevealToken('provider', token)) {
      return { ok: false as const, error: '查看密钥需重新确认' }
    }
    securityEventRepo.append({
      kind: CREDENTIAL_REVEAL_KIND,
      message: `揭示 provider 凭据: ${id}`,
      detail: { providerId: id }
    })
    markRevealDone('provider', id)
    const rec = providerRepo.get(id)
    return { ok: true as const, apiKeys: rec?.apiKeys ?? [] }
  }, argsSchema(idSchema, z.string()))

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
