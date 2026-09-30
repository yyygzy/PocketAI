// 会话智能标题开关（app_config KV，缺省开启）
import { appConfigRepo } from '../db/repositories/app-config.repo'

const K_SMART_TITLE_ENABLED = 'conv.smart_title.enabled'

/** 是否启用「首条消息后用模型生成短标题」；未配置时默认开启 */
export function isSmartTitleEnabled(): boolean {
  return appConfigRepo.get(K_SMART_TITLE_ENABLED) !== '0'
}

export function setSmartTitleEnabled(enabled: boolean): void {
  appConfigRepo.set(K_SMART_TITLE_ENABLED, enabled ? '1' : '0')
}
