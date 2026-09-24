// web_search 工具的联网搜索配置（app_config KV，模式与 shell-config 一致）
//
// - agent.websearch_enabled  ：'1' 开启；缺省/其它=关闭（默认安全）
// - agent.websearch_provider ：'tavily'（默认）| 'bocha'
// - agent.websearch_api_key  ：服务商 API Key（字段级密文，secret-store 统一管理）
//
// 安全约定：getWebSearchConfig 面向渲染端返回时永远不回传 Key 明文（apiKey='' + hasKey 标记）；
// 主进程内部读 Key 用 getWebSearchSecret()。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { getSecret, setSecret, hasSecret, SECRET_KV_KEYS } from '../crypto/secret-store'
import type { WebSearchConfig, WebSearchProvider } from '../../shared/types'
import { websearchConfigSchema } from '../../shared/schemas/agent'

const KEY_ENABLED = 'agent.websearch_enabled'
const KEY_PROVIDER = 'agent.websearch_provider'
const KEY_API_KEY = SECRET_KV_KEYS.WEBSEARCH_API_KEY

/** 渲染端视图：不含 Key 明文 */
export function getWebSearchConfig(): WebSearchConfig {
  const enabled = appConfigRepo.get(KEY_ENABLED) === '1'
  const providerRaw = appConfigRepo.get(KEY_PROVIDER)
  const provider: WebSearchProvider = providerRaw === 'bocha' ? 'bocha' : 'tavily'
  return { enabled, provider, apiKey: '', hasKey: hasSecret(KEY_API_KEY) }
}

/** 保存配置（字段白名单 + 值域校验）。apiKey：undefined=不动，''=清除，非空=覆盖 */
export function setWebSearchConfig(
  input: Partial<{ enabled: boolean; provider: WebSearchProvider; apiKey: string }>
): WebSearchConfig {
  const patch = websearchConfigSchema.parse(input)
  if (typeof patch.enabled === 'boolean') {
    appConfigRepo.set(KEY_ENABLED, patch.enabled ? '1' : '0')
  }
  if (patch.provider === 'tavily' || patch.provider === 'bocha') {
    appConfigRepo.set(KEY_PROVIDER, patch.provider)
  }
  if (typeof patch.apiKey === 'string') {
    const trimmed = patch.apiKey.trim()
    if (trimmed.length === 0) {
      setSecret(KEY_API_KEY, '')
    } else if (trimmed.length > 256) {
      // 不静默丢弃：明确拒绝，由渲染端提示用户（上限对应历史存储约束）
      throw new Error('API Key 过长（上限 256 字符），请检查后重试')
    } else {
      setSecret(KEY_API_KEY, trimmed)
    }
  }
  return getWebSearchConfig()
}

/** 主进程内部读取 Key 明文（仅供 websearch.ts 发请求用） */
export function getWebSearchSecret(): { enabled: boolean; provider: WebSearchProvider; apiKey: string } {
  const enabled = appConfigRepo.get(KEY_ENABLED) === '1'
  const providerRaw = appConfigRepo.get(KEY_PROVIDER)
  const provider: WebSearchProvider = providerRaw === 'bocha' ? 'bocha' : 'tavily'
  return { enabled, provider, apiKey: getSecret(KEY_API_KEY) }
}
