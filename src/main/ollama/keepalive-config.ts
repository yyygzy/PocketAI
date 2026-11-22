// Ollama keep_alive 驻留配置（prefix caching 配套）。
//
// Ollama 的 prompt/prefix cache 只在模型驻留内存时命中；默认 5 分钟卸载后缓存丢失、
// 下一次请求要重新 prefill 整段前缀（长 Agent 会话尤其明显）。这里把官方 keep_alive
// 参数暴露成一个可选配置：未配置时不下发任何字段，兼容所有 OpenAI 兼容端点；
// 只有 provider.type==='ollama' 且配置过时才把它放进 /v1/chat/completions 请求体。
//
// 值形如 '10m' / '24h' / '-1'（永久驻留）/ 0（立即卸载）；校验放宽为官方接受的时间串/数字。
import { appConfigRepo } from '../db/repositories/app-config.repo'

const KEY = 'ollama_keep_alive'
/** 太长的值没有意义且会占显存；限制到 32 字符 */
const MAX_LEN = 32
const PATTERN = /^(-?\d+(?:\.[0-9]+)?(?:ms|s|m|h)?|-1)$/

/** 读取并规范化 keep_alive；空/非法值返回 undefined（＝不下发，用 Ollama 默认 5 分钟） */
export function getOllamaKeepAlive(): string | undefined {
  const raw = (appConfigRepo.get(KEY) ?? '').trim()
  if (!raw || raw.length > MAX_LEN) return undefined
  return PATTERN.test(raw) ? raw : undefined
}

/** 写出 keep_alive；传空串/null 清除配置。非法值由调用方先校验（这里返回 boolean） */
export function setOllamaKeepAlive(value: string | null): boolean {
  const v = (value ?? '').trim()
  if (!v) {
    appConfigRepo.set(KEY, '')
    return true
  }
  if (v.length > MAX_LEN || !PATTERN.test(v)) return false
  appConfigRepo.set(KEY, v)
  return true
}
