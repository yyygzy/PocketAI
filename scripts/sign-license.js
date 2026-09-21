#!/usr/bin/env node
// License 签发脚本（仅发行侧使用）——命令行一行式
// 推荐交互式工具：node scripts/license-studio.js（npm run license），防手滑出错
//
// 使用方式（私钥默认 build/license-private.pem，由 scripts/generate-license-key.js 生成）：
//   node scripts/sign-license.js --owner "张三" --plan pro --days 3650
//   node scripts/sign-license.js --owner "XX公司" --plan enterprise --expires 2027-12-31 --features mcp,agent,backup
//   node scripts/sign-license.js --owner "张三" --plan pro --fingerprint 1a2b3c4d5e6f7a8b --out 张三.lic
//
// 说明：
// - --days 不传且 --expires 不传 = expires_at 取 2099 年（视为永久，一次性买断）
// - --fingerprint 传入硬盘指纹（应用设置页可查看，16 位 hex）= 绑定设备，仅该硬盘可激活；
//   不传 = 不绑定（任何硬盘可用，老格式行为）
// - 输出为 license.lic JSON 文本（与 loadFromString 兼容），可让用户在
//   设置 → 授权激活 里「导入文件」或「粘贴激活内容」完成离线激活
const fs = require('node:fs')
const path = require('node:path')
const { issueLicense, describeExpiry } = require('./lib/issue-license')

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const owner = arg('owner')
if (!owner) {
  console.error('用法: node scripts/sign-license.js --owner "张三" [--plan pro|enterprise] [--days 3650 | --expires 2027-12-31] [--features mcp,agent] [--fingerprint <16位hex>] [--out file.lic]')
  process.exit(1)
}

const plan = arg('plan') || 'pro'
const days = arg('days')
const expires = arg('expires')
let expiresAt
if (days) expiresAt = Date.now() + Number(days) * 86400_000
else if (expires) expiresAt = new Date(expires + 'T23:59:59+08:00').getTime()

try {
  const r = issueLicense({
    owner,
    plan,
    expiresAt,
    features: (arg('features') || undefined)?.split(',').map((s) => s.trim()).filter(Boolean),
    diskFingerprint: arg('fingerprint') || '',
    keyPath: arg('key') || path.join(__dirname, '..', 'build', 'license-private.pem')
  })

  console.log('--- license.lic 内容（发给用户导入，或保存为文件） ---')
  console.log(r.licenseJson)
  console.log('\n--- payload ---')
  console.log(`owner=${r.payload.owner} plan=${r.payload.plan} 到期=${describeExpiry(r.expiresAt)} 绑定=${r.payload.disk_fingerprint || '不绑定设备'}`)

  const outFile = arg('out')
  if (outFile) {
    fs.writeFileSync(outFile, r.licenseJson, 'utf8')
    console.log('\n已写入 ' + outFile)
  }
} catch (e) {
  console.error('签发失败: ' + e.message)
  process.exit(1)
}
