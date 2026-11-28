// License 签发共享核心（sign-license.js CLI 与 license-studio.js 交互工具共用）
// 规范化字段集与 src/main/license/license.ts 的 canonicalize 保持一致，改动需双向同步
//
// SEC-16-15 私钥来源（私钥绝不能进仓库/交付工作区，也不得由本脚本生成）：
//   1. 显式 keyPath（测试或离线签名机临时挂载）
//   2. 环境变量 POCKETAI_LICENSE_PRIVATE_KEY（PEM 全文，CI Secret 注入）
//   3. 环境变量 POCKETAI_LICENSE_PRIVATE_KEY_PATH（外部绝对路径）
//   4. 兜底历史路径 build/license-private.pem（SEC-16-02 要求运维移出，仅兼容旧流程）
// Ed25519 私钥签出的签名带 `ed25519:` 前缀；RSA 私钥仍签裸 base64，老证过渡期照常验签。
const { createPrivateKey, createSign, sign } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const PLANS = ['free', 'pro', 'enterprise']
const DEFAULT_FEATURES = 'mcp,agent,backup,encryption,multi-runtime'
const ED25519_SIGNATURE_PREFIX = 'ed25519:'
const DEFAULT_KEY_PATH = path.join(__dirname, '..', '..', 'build', 'license-private.pem')
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

/** 取发行私钥 PEM；只读取外部路径/环境变量，本脚本从不生成或写出私钥 */
function resolvePrivateKey(keyPath) {
  // sign-license.js 把默认路径作为 keyPath 显式传入；有环境变量时应优先用外部私钥。
  const isDefaultPath = !keyPath || path.resolve(keyPath) === DEFAULT_KEY_PATH
  let pem = ''
  let source = ''
  if (keyPath && !isDefaultPath) {
    if (!fs.existsSync(keyPath)) throw new Error(`缺少私钥 ${keyPath}（私钥由发行侧在仓库外保管）`)
    pem = fs.readFileSync(keyPath, 'utf8')
    source = keyPath
  } else if (process.env.POCKETAI_LICENSE_PRIVATE_KEY && process.env.POCKETAI_LICENSE_PRIVATE_KEY.trim()) {
    pem = process.env.POCKETAI_LICENSE_PRIVATE_KEY.trim()
    source = '环境变量 POCKETAI_LICENSE_PRIVATE_KEY'
  } else if (process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH) {
    const external = process.env.POCKETAI_LICENSE_PRIVATE_KEY_PATH
    if (!fs.existsSync(external)) throw new Error(`缺少私钥 ${external}（POCKETAI_LICENSE_PRIVATE_KEY_PATH 指向的文件不存在）`)
    pem = fs.readFileSync(external, 'utf8')
    source = external
  } else {
    if (!fs.existsSync(DEFAULT_KEY_PATH)) {
      throw new Error(`缺少私钥 ${DEFAULT_KEY_PATH}（先运行 node scripts/generate-license-key.js 生成，或改用环境变量提供仓库外私钥）`)
    }
    pem = fs.readFileSync(DEFAULT_KEY_PATH, 'utf8')
    source = DEFAULT_KEY_PATH
  }

  let key
  try {
    key = createPrivateKey(pem)
  } catch (e) {
    throw new Error(`私钥内容无效（${source}）: ${e.message}`)
  }
  return { pem, key, source }
}

/** 按私钥类型签发：Ed25519 带版本前缀，RSA 保持历史裸 base64 */
function signCanonical(canonical, pem, key, algorithm) {
  const actual = key.asymmetricKeyType === 'ed25519' ? 'ed25519' : 'rsa'
  if (algorithm && algorithm !== 'auto' && algorithm !== actual) {
    throw new Error(`私钥类型为 ${actual}，与请求的签名算法 ${algorithm} 不符`)
  }
  if (actual === 'ed25519') {
    return {
      algorithm: actual,
      signature: ED25519_SIGNATURE_PREFIX + sign(null, Buffer.from(canonical, 'utf8'), key).toString('base64')
    }
  }
  const signer = createSign('RSA-SHA256')
  signer.update(canonical)
  signer.end()
  return { algorithm: actual, signature: signer.sign(pem, 'base64') }
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
 * @param {string} [opts.keyPath]    私钥路径；未传时优先读环境变量（见文件头），最后兜底历史默认路径
 * @param {'auto'|'ed25519'|'rsa'} [opts.algorithm] 签名算法，默认 auto（按私钥类型）
 * @returns {{ licenseJson: string, payload: object, licenseId: string, expiresAt: number, updatesUntil: number|undefined, algorithm: string }}
 */
function issueLicense({ owner, plan, days, expiresAt, updatesDays, updatesUntil, features, diskFingerprint, keyPath, algorithm }) {
  if (!owner || !String(owner).trim()) throw new Error('owner 不能为空')
  if (!PLANS.includes(plan)) throw new Error(`plan 仅支持 ${PLANS.join(' / ')}`)
  const { pem, key } = resolvePrivateKey(keyPath)
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

  const { algorithm: usedAlgorithm, signature } = signCanonical(canonicalize(payload), pem, key, algorithm)

  return {
    licenseJson: JSON.stringify({ ...payload, signature }, null, 2),
    payload,
    licenseId: payload.license_id,
    expiresAt: exp,
    updatesUntil: upd,
    algorithm: usedAlgorithm
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
