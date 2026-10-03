// 主进程出网代理（模型对话 / embedding / 图片生成 / MCP HTTP / Channels 网关 /
// license 激活等所有走全局 fetch 的主进程流量）
//
// 背景：Electron 主进程的全局 fetch 由 Node 内置 undici 提供，默认不读系统代理，
// Clash / V2Ray 等仅设置系统代理时对主进程 API 请求不生效。这里：
//   1) 显式依赖 undici 包（package.json dependencies），用其 EnvHttpProxyAgent
//      按目标 host 路由（localhost 等回环地址直连，其余走 HTTP CONNECT 代理）；
//   2) 外部 undici 包的 setGlobalDispatcher 不影响 Electron 内置全局 fetch，
//      因此首次应用时把 globalThis.fetch 替换为 undici 包的 fetch
//      （标准 Web Fetch，SSE body.getReader() / redirect:'manual' 均兼容）。
// 不覆盖 safeFetch 下载链路（python/ollama/图片下载走自带 SSRF 收口，刻意分离）。
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from 'undici'
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { IPC } from '../../shared/types'
import { safeHandle, argsSchema, z } from '../ipc/safe-handle'
import { createLogger } from '../logger'

const log = createLogger('proxy')

/** 回环地址永远直连：本地 ollama、本机 MCP HTTP 服务等不应被代理接管 */
const LOCAL_NO_PROXY = 'localhost,127.0.0.1,::1'

/**
 * 校验并规整代理 URL（纯函数，非法即抛错，错误信息直接面向用户）。
 * - null/undefined/空白 → null（直连语义，UI 输入框留空）
 * - 仅支持 http:// 与 https:// 代理（主流代理软件均提供 HTTP 混合端口）；
 *   socks5/ftp/无协议串一律拒绝
 * - 必须含主机名；去掉末尾斜杠；保留内嵌 user:pass（undici 原生支持）
 */
export function normalizeProxyUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim()
  if (s === '') return null
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw new Error('代理地址格式无效，需形如 http://127.0.0.1:7890')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http:// 或 https:// 代理，暂不支持 socks5')
  }
  if (!u.hostname) throw new Error('代理地址缺少主机名')
  return u.href.replace(/\/+$/, '')
}

/** 全局 fetch 是否已替换为 undici fetch（全程只替换一次，空代理也走 undici 直连 Agent） */
let fetchPatched = false

/**
 * 读取已保存配置并应用到全局 dispatcher；任何异常只记日志不抛出
 * （boot 阶段调用，代理配置错误不得阻断启动）。
 */
export function applyProxySettings(): void {
  try {
    const normalized = normalizeProxyUrl(appConfigRepo.getProxyUrl())
    if (normalized) {
      setGlobalDispatcher(new EnvHttpProxyAgent({
        httpProxy: normalized,
        httpsProxy: normalized,
        noProxy: LOCAL_NO_PROXY
      }))
      log.info(`出网代理已启用: ${normalized}（回环地址直连）`)
    } else {
      setGlobalDispatcher(new Agent())
    }
    if (!fetchPatched) {
      ;(globalThis as { fetch: unknown }).fetch = undiciFetch
      fetchPatched = true
    }
  } catch (e) {
    log.warn('应用代理设置失败:', e instanceof Error ? e.message : e)
  }
}

/** 保存代理 URL 并立即应用；返回规整后的值（''=直连）。非法地址抛错且不写库 */
export function saveProxyUrl(raw: string): string {
  const normalized = normalizeProxyUrl(raw)
  const value = normalized ?? ''
  appConfigRepo.setProxyUrl(value)
  applyProxySettings()
  return value
}

/** 注册网络代理 IPC（boot 阶段、DB 已开后调用一次） */
export function registerProxyHandlers(): void {
  safeHandle(IPC.NET_PROXY_GET, () => appConfigRepo.getProxyUrl())
  safeHandle(
    IPC.NET_PROXY_SET,
    (_e, raw: string) => saveProxyUrl(raw),
    argsSchema(z.string().max(200))
  )
}
