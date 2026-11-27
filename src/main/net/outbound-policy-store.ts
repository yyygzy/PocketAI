// 出网策略的持久化层：只被 IPC handler 引，不进 safeFetch 的依赖图。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { dbService } from '../db/database'
import {
  DEFAULT_OUTBOUND_SITE_POLICY,
  OUTBOUND_POLICY_KEY,
  normalizeOutboundSitePolicy,
  type OutboundSitePolicy
} from './outbound-policy'

export function getOutboundSitePolicy(): OutboundSitePolicy {
  try {
    if (!dbService.isOpen()) {
      return { ...DEFAULT_OUTBOUND_SITE_POLICY, allowedHosts: [] }
    }
    const raw = appConfigRepo.get(OUTBOUND_POLICY_KEY)
    return raw
      ? normalizeOutboundSitePolicy(JSON.parse(raw))
      : { ...DEFAULT_OUTBOUND_SITE_POLICY, allowedHosts: [] }
  } catch {
    // 读不到策略时退回默认关闭；UI 会通过 IPC 失败面把原因说出来，不静默放行被用户关住的门。
    return { ...DEFAULT_OUTBOUND_SITE_POLICY, allowedHosts: [] }
  }
}

export function saveOutboundSitePolicy(input: unknown): OutboundSitePolicy {
  const policy = normalizeOutboundSitePolicy(input)
  appConfigRepo.set(OUTBOUND_POLICY_KEY, JSON.stringify(policy))
  return policy
}
