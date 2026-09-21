// 激活服务器地址配置
//
// - 开发/测试期指向本地激活服务器（license-server/server.js）
// - 上线前替换为正式域名（建议由 nginx/caddy 终结 HTTPS；license 本身 RSA 签名，
//   明文传输下中间人只能阻断激活，无法伪造 license）
export const ACTIVATION_BASE_URL = 'http://127.0.0.1:8787'
