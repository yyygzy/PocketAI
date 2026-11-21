// 激活服务器地址配置
//
// - 默认指向本地激活服务器（license-server/server.js）供开发/测试使用；
//   发行版通过环境变量 POCKETAI_LICENSE_URL 注入正式域名（打包时由 release 脚本设置），
//   避免把开发地址硬编进发布包（SEC-26）。
// - 上行卡密是明文 POST body：非回环主机强制 https，拒绝明文 http（M2）。
//   本机回环仍允许 http，保留本地开发体验；配置非法时直接抛错拒绝启动，不静默降级。
const DEV_DEFAULT = 'http://127.0.0.1:8787'

/** 仅这几个本机回环形态允许明文 http；127.0.0.0/8 整段都算回环 */
function isLoopbackHost(u: URL): boolean {
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return h === 'localhost' || h === '::1' || h.startsWith('127.')
}

/** 注入校验：http(s) 绝对地址；公网主机必须 https，否则拒绝启动 */
function resolveActivationBase(): string {
  const raw = process.env['POCKETAI_LICENSE_URL']?.trim()
  if (!raw) return DEV_DEFAULT
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new Error('POCKETAI_LICENSE_URL 不是合法的 http(s) 绝对地址')
  }
  if (u.protocol === 'https:') return raw.replace(/\/+$/, '')
  if (u.protocol === 'http:' && isLoopbackHost(u)) return raw.replace(/\/+$/, '')
  throw new Error('POCKETAI_LICENSE_URL 必须使用 https（仅本机回环允许明文 http）')
}

export const ACTIVATION_BASE_URL = resolveActivationBase()
