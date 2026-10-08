// 激活服务器地址配置
//
// - 默认指向本地激活服务器（license-server/server.js）供开发/测试使用；
//   发行版通过环境变量 POCKETAI_LICENSE_URL 注入正式域名（打包时由 release 脚本设置），
//   避免把开发地址硬编进发布包（SEC-26）。
// - 传输可由 nginx/caddy 终结 HTTPS；license 本身 RSA 签名，明文传输下中间人只能阻断激活，
//   无法伪造 license（本地仍会用公钥验签）。
const DEV_DEFAULT = 'http://127.0.0.1:8787'

/** 注入校验：只接受 http(s) 绝对地址，防止被环境变量塞入 file:/相对路径等畸形值 */
function resolveActivationBase(): string {
  const raw = process.env['POCKETAI_LICENSE_URL']?.trim()
  if (!raw) return DEV_DEFAULT
  try {
    const u = new URL(raw)
    if (u.protocol === 'https:' || u.protocol === 'http:') return raw.replace(/\/+$/, '')
  } catch {
    /* 落到默认值 */
  }
  return DEV_DEFAULT
}

export const ACTIVATION_BASE_URL = resolveActivationBase()
