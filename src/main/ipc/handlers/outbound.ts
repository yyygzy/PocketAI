// 出网清单 + v2 全局 allowlist。
//
// 清单本身来自 net/outbound-registry.ts（覆盖测试盯住调用点），这里把注册表 +
// 从现有配置仓储解析出的当前真实地址交给渲染端；策略读写走独立通道，默认关闭。
import { z } from 'zod'
import { IPC } from '../../../shared/types'
import { getOutboundEntriesView } from '../../net/outbound-registry'
import { setOutboundPolicyReader } from '../../net/outbound-policy'
import { getOutboundSitePolicy, saveOutboundSitePolicy } from '../../net/outbound-policy-store'
import { argsSchema, safeHandle } from '../safe-handle'

const policySchema = z.object({
  enabled: z.boolean(),
  allowedHosts: z.array(z.string().max(253)).max(200)
})

export function registerOutboundHandlers(): void {
  // safeFetch 在 IPC 注册前就可能被调用；未注入前默认关闭，注册后所有请求按用户策略走。
  setOutboundPolicyReader(getOutboundSitePolicy)
  safeHandle(IPC.OUTBOUND_GET, () => getOutboundEntriesView())
  safeHandle(IPC.OUTBOUND_POLICY_GET, () => getOutboundSitePolicy())
  safeHandle(
    IPC.OUTBOUND_POLICY_SET,
    (_e, input: { enabled: boolean; allowedHosts: string[] }) => saveOutboundSitePolicy(input),
    argsSchema(policySchema)
  )
}
