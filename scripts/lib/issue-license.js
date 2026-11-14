// License 签发共享核心（sign-license.js CLI 与 license-studio.js 交互工具共用）
// 规范化字段集与 src/main/license/license.ts 的 canonicalize 保持一致，改动需双向同步
const { createSign } = require('node:crypto')
const fs = require('node:fs')

const PLANS = ['free', 'pro', 'enterprise']
const DEFAULT_FEATURES = 'mcp,agent,backup,encryption,multi-runtime'
/**
 * 过渡策略（v1 → v2，与产品侧约定一致）：
 * - 默认签发 v1（不含 updates_until）：旧版本客户端用 8 字段规范化，遇到 v2 件会验签失败，
 *   因此在新版客户端铺开前继续签 v1；v1 件在运行时按「更新期 = 使用截止」兜底。
 * - 只有显式传入 updatesDays / updatesUntil 时才签 v2（写入并签 updates_until）。
 * - 切换条件：新版客户端铺开后（旧版本占比可忽略、用户已可自助升级），
 *   再把默认改为 v2 并同步更新本注释与签发文档；切换前新证在旧客户端上激活不了。
 */
const SIGN_FIELDS_V1 = ['disk_fingerprint', 'expires_at', 'features', 'issued_at', 'license_id', 'owner', 'plan', 'version']
const SIGN_FIELDS_V2 = ['disk_fingerprint', 'expires_at', 'features', 'issued_at', 'license_id', 'owner', 'plan', 'updates_until', 'version']

function signFieldsOf(payload) {
  return payload.updates_until === undefined ? SIGN_FIELDS_V1 : SIGN_FIELDS_V2
}

function canonicalize(payload) {
  return signFieldsOf(payload)
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
 * @param {number} [opts.expiresAt]  使用截止毫秒时间戳
 * @param {number} [opts.updatesDays] 更新期天数；不传 = 签发 v1（更新期跟随使用截止）
 * @param {number} [opts.updatesUntil] 更新截止毫秒时间戳（显式给出时优先于 updatesDays）
 * @param {string[]} [opts.features] 功能列表，默认全量
 * @param {string} [opts.diskFingerprint] 硬盘指纹（SHA-256 前 16 位 hex）；缺省空串 = 不绑定设备
 * @param {string} [opts.keyPath]    私钥路径，默认 build/license-private.pem
 * @returns {{ licenseJson: string, payload: object, licenseId: string, expiresAt: number, updatesUntil: number|undefined }}
 */
function issueLicense({ owner, plan, days, expiresAt, updatesDays, updatesUntil, features, diskFingerprint, keyPath }) {
  if (!owner || !String(owner).trim()) throw new Error('owner 不能为空')
  if (!PLANS.includes(plan)) throw new Error(`plan 仅支持 ${PLANS.join(' / ')}`)
  const keyFile = keyPath || require('node:path').join(__dirname, '..', '..', 'build', 'license-private.pem')
  if (!fs.existsSync(keyFile)) throw new Error(`缺少私钥 ${keyFile}（先运行 node scripts/generate-license-key.js 生成）`)
  if (!features || features.length === 0) features = DEFAULT_FEATURES.split(',')

  const issuedAt = Date.now()
  let exp
  if (days) exp = issuedAt + Number(days) * 86400_000
  else if (expiresAt) exp = expiresAt
  else exp = PERPETUAL

  // 更新截止：显式给出才写入（签 v2）；否则保持 v1，运行时回退为使用截止。
  // 显式 updatesUntil 优先；只给天数时不超过使用截止。
  let upd
  if (Number.isFinite(updatesUntil)) upd = updatesUntil
  else if (Number.isFinite(updatesDays)) upd = Math.min(issuedAt + updatesDays * 86400_000, exp)

  const payload = {
    version: upd === undefined ? 1 : 2,
    license_id: newLicenseId(),
    owner: String(owner).trim(),
    issued_at: issuedAt,
    expires_at: exp,
    ...(upd === undefined ? {} : { updates_until: upd }),
    plan,
    features: features.map((s) => String(s).trim()).filter(Boolean),
    // 空串 = 不绑定设备（可在任何硬盘使用）；非空 = 只能在指纹匹配的硬盘上激活
    disk_fingerprint: String(diskFingerprint ?? '').trim().toLowerCase()
  }

  const sign = createSign('RSA-SHA256')
  sign.update(canonicalize(payload))
  sign.end()
  const signature = sign.sign(fs.readFileSync(keyFile, 'utf8'), 'base64')

  return {
    licenseJson: JSON.stringify({ ...payload, signature }, null, 2),
    payload,
    licenseId: payload.license_id,
    expiresAt: exp,
    updatesUntil: upd
  }
}

/** 到期时间的人类可读描述 */
function describeExpiry(expiresAt) {
  if (expiresAt === PERPETUAL) return '永久（2099-12-31，买断）'
  const ms = expiresAt - Date.now()
  const years = (ms / 86400_000 / 365).toFixed(1)
  return `${new Date(expiresAt).toLocaleDateString('zh-CN')}（约 ${years} 年）`
}

/** 更新截止的人类可读描述 */
function describeUpdates(updatesUntil) {
  if (!Number.isFinite(updatesUntil)) return '跟随使用截止（v1 件，兼容旧客户端）'
  return `${new Date(updatesUntil).toLocaleDateString('zh-CN')}（更新期内可获取新版本）`
}

module.exports = {
  issueLicense,
  canonicalize,
  PLANS,
  DEFAULT_FEATURES,
  PERPETUAL,
  describeExpiry,
  describeUpdates,
  newLicenseId
}
