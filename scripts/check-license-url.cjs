'use strict'

// 发行前断言（M2）：正式激活地址必须 https；仅本机回环允许明文 http。
// 未设置环境变量时使用本地开发默认值，构建本身不失败。
const raw = typeof process.env.POCKETAI_LICENSE_URL === 'string'
  ? process.env.POCKETAI_LICENSE_URL.trim()
  : ''

if (!raw) {
  console.log('[check-license-url] 未设置 POCKETAI_LICENSE_URL（使用本机开发默认值）')
  process.exit(0)
}

let u
try {
  u = new URL(raw)
} catch {
  console.error('[check-license-url] POCKETAI_LICENSE_URL 不是合法的绝对 URL')
  process.exit(1)
}

const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
const loopback = host === 'localhost' || host === '::1' || host.startsWith('127.')

if (u.protocol === 'https:') {
  console.log('[check-license-url] HTTPS 激活地址校验通过')
  process.exit(0)
}
if (u.protocol === 'http:' && loopback) {
  console.log('[check-license-url] 本机回环 HTTP 校验通过（仅开发用）')
  process.exit(0)
}

console.error('[check-license-url] 正式激活地址必须使用 https（仅本机回环允许 http）')
process.exit(1)
