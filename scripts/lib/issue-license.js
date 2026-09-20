// License 签发共享核心（sign-license.js CLI 与 license-studio.js 交互工具共用）
// 规范化字段集与 src/main/license/license.ts 的 canonicalize 保持一致，改动需双向同步
const { createSign } = require('node:crypto')
const fs = require('node:fs')

const PLANS = ['free', 'pro', 'enterprise']
const DEFAULT_FEATURES = 'mcp,agent,backup,encryption,multi-runtime'
const SIGN_FIELDS = ['expires_at', 'features', 'issued_at', 'license_id', 'owner', 'plan', 'version']

function canonicalize(payload) {
  return SIGN_FIELDS
    .map((k) => {
      const v = payload[k]
      return `${k}=${Array.isArray(v) ? JSON.stringify(v.slice().sort()) : String(v)}`
    })
    .join('&')

}

function newLicenseId() {
  return 'LIC-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2, 8).toUpperCase()
}

/** 永久到期时间（2099 年，视为买断） */
const PERPETUAL = new Date('2099-12-31T23:59:59+08:00').getTime()

/**
 * 签发一份 license
 * @param {object} opts
 * @param {string} opts.owner        授权给（姓名/组织）
 * @param {string} opts.plan         free | pro | enterprise
 * @param {number} [opts.days]       有效天数（与 expiresAt/expiresDate 三选一）
 * @param {number} [opts.expiresAt]  到期毫秒时间戳
 * @param {string[]} [opts.features] 功能列表，默认全量
 * @param {string} [opts.keyPath]    私钥路径，默认 build/license-private.pem
 * @returns {{ licenseJson: string, payload: object, licenseId: string, expiresAt: number }}
 */
function issueLicense({ owner, plan, days, expiresAt, features, keyPath }) {
  if (!owner || !String(owner).trim()) throw new Error('owner 不能为空')
  if (!PLANS.includes(plan)) throw new Error(`plan 仅支持 ${PLANS.join(' / ')}`)
  const keyFile = keyPath || require('node:path').join(__dirname, '..', '..', 'build', 'license-private.pem')
  if (!fs.existsSync(keyFile)) throw new Error(`缺少私钥 ${keyFile}（先运行 node scripts/generate-license-key.js 生成）`)
  if (!features || features.length === 0) features = DEFAULT_FEATURES.split(',')

  let exp
  if (days) exp = Date.now() + Number(days) * 86400_000
  else if (expiresAt) exp = expiresAt
  else exp = PERPETUAL

  const payload = {
    version: 1,
    license_id: newLicenseId(),
    owner: String(owner).trim(),
    issued_at: Date.now(),
    expires_at: exp,
    plan,
    features: features.map((s) => String(s).trim()).filter(Boolean)
  }

  const sign = createSign('RSA-SHA256')
  sign.update(canonicalize(payload))
  sign.end()
  const signature = sign.sign(fs.readFileSync(keyFile, 'utf8'), 'base64')

  return { licenseJson: JSON.stringify({ ...payload, signature }, null, 2), payload, licenseId: payload.license_id, expiresAt: exp }
}

/** 到期时间的人类可读描述 */
function describeExpiry(expiresAt) {
  if (expiresAt === PERPETUAL) return '永久（2099-12-31，买断）'
  const ms = expiresAt - Date.now()
  const years = (ms / 86400_000 / 365).toFixed(1)
  return `${new Date(expiresAt).toLocaleDateString('zh-CN')}（约 ${years} 年）`
}

module.exports = { issueLicense, canonicalize, PLANS, DEFAULT_FEATURES, PERPETUAL, describeExpiry, newLicenseId }
