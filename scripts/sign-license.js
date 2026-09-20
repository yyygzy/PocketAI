#!/usr/bin/env node
// License 签发脚本（仅发行侧使用）
//
// 使用方式（私钥默认 build/license-private.pem，由 scripts/generate-license-key.js 生成）：
//   node scripts/sign-license.js --owner "张三" --plan pro --days 3650
//   node scripts/sign-license.js --owner "XX公司" --plan enterprise --expires 2027-12-31 --features mcp,agent,backup
//   node scripts/sign-license.js --owner "张三" --plan pro --out 张三.lic   # 同时写文件
//
// 说明：
// - --days 不传且 --expires 不传 = expires_at 取 2099 年（视为永久，一次性买断）
// - 输出为 license.lic JSON 文本（与 loadFromString 兼容），可让用户在
//   设置 → 授权激活 里「导入文件」或「粘贴激活内容」完成离线激活
const { createSign } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const owner = arg('owner')
if (!owner) {
  console.error('用法: node scripts/sign-license.js --owner "张三" [--plan pro|enterprise] [--days 3650 | --expires 2027-12-31] [--features mcp,agent] [--out file.lic]')
  process.exit(1)
}

const keyPath = arg('key') || path.join(__dirname, '..', 'build', 'license-private.pem')
if (!fs.existsSync(keyPath)) {
  console.error(`缺少私钥 ${keyPath}（先用 scripts/generate-license-key.js 生成，私钥只保存在发行侧）`)
  process.exit(1)
}

const plan = arg('plan') || 'pro'
if (!['free', 'pro', 'enterprise'].includes(plan)) {
  console.error('plan 仅支持 free / pro / enterprise')
  process.exit(1)
}

const days = arg('days')
const expires = arg('expires')
let expiresAt
if (days) expiresAt = Date.now() + Number(days) * 86400_000
else if (expires) expiresAt = new Date(expires + 'T23:59:59+08:00').getTime()
else expiresAt = new Date('2099-12-31T23:59:59+08:00').getTime()

const features = (arg('features') || 'mcp,agent,backup,encryption,multi-runtime')
  .split(',').map((s) => s.trim()).filter(Boolean)

// 与 src/main/license/license.ts 的 canonicalize 字段集保持一致
const payload = {
  version: 1,
  license_id: 'LIC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
  owner,
  issued_at: Date.now(),
  expires_at: expiresAt,
  plan,
  features
}

const SIGN_FIELDS = ['expires_at', 'features', 'issued_at', 'license_id', 'owner', 'plan', 'version']
const canonicalize = (p) =>
  SIGN_FIELDS
    .map((k) => {
      const v = p[k]
      return `${k}=${Array.isArray(v) ? JSON.stringify(v.slice().sort()) : String(v)}`
    })
    .join('&')

const signedData = canonicalize(payload)
const sign = createSign('RSA-SHA256')
sign.update(signedData)
sign.end()
const signature = sign.sign(fs.readFileSync(keyPath, 'utf8'), 'base64')

const licenseJson = JSON.stringify({ ...payload, signature }, null, 2)

console.log('--- license.lic 内容（发给用户导入，或保存为文件） ---')
console.log(licenseJson)
console.log('\n--- payload ---')
console.log(`owner=${payload.owner} plan=${payload.plan} 到期=${new Date(payload.expires_at).toLocaleString('zh-CN')}`)

const outFile = arg('out')
if (outFile) {
  fs.writeFileSync(outFile, licenseJson, 'utf8')
  console.log('\n已写入 ' + outFile)
}
