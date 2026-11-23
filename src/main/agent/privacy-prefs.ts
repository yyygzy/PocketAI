// 隐私/离线模式：禁止把对话内容发往云端模型（fail-safe）。
//
// 语义：
//  - **缺省/读取异常都按"开启"**：只有 app_config 里显式写 '0' 才是关闭。
//    这样新用户、配置损坏、DB 异常时都走安全侧，不会悄悄把敏感代码发出去。
//  - 只认纯回环地址（localhost/127.0.0.1/[::1]）为"本地模型"；局域网 IP 也算云端，
//    保守拒绝。判不出（baseUrl 空/非法）一律视为云端——与 delegation.ts 的
//    providerEndpointLocal() 缺省方向相反（那边判不出按本地以省上下文，这里必须反过来）。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { isLocalInferenceBaseUrl } from '../providers/local-slot'
import { providerRepo } from '../db/repositories/provider.repo'

const K_PRIVACY_MODE = 'agent.privacy_mode'

/**
 * 隐私模式是否开启。**缺省/异常 → true（fail-safe）**。
 * 与 jev-review / keepalive 那批"缺省关"相反：隐私是安全属性，宁可多拦不可漏放。
 */
export function isPrivacyModeEnabled(): boolean {
  try {
    return appConfigRepo.get(K_PRIVACY_MODE) !== '0'
  } catch {
    return true
  }
}

/** 显式设置；返回是否成功（配置写入失败时保持原状，不伪装成功） */
export function setPrivacyMode(on: boolean): boolean {
  try {
    appConfigRepo.set(K_PRIVACY_MODE, on ? '1' : '0')
    return true
  } catch {
    return false
  }
}

/**
 * 该 provider 能否在隐私模式下使用：只有 baseUrl 是回环地址才允许。
 * **判不出（记录不存在 / baseUrl 空）→ false**，与 providerEndpointLocal 的缺省方向相反。
 */
export function isProviderAllowedUnderPrivacy(providerId: string): boolean {
  if (!isPrivacyModeEnabled()) return true
  const record = providerRepo.get(providerId)
  return !!record && isLocalInferenceBaseUrl(record.baseUrl)
}

export interface PrivacyModeState {
  enabled: boolean
}

export function getPrivacyMode(): PrivacyModeState {
  return { enabled: isPrivacyModeEnabled() }
}
