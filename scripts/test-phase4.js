// 快速验证脚本：检查迁移 v5 表是否存在 + 测试 License 验签
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')
const fs = require('node:fs')
const crypto = require('node:crypto')

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db')
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
db.pragma('journal_mode = WAL')

// 1. 检查迁移版本
const migs = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
console.log('[migrations]:', migs.map(m => `v${m.version} ${m.name}`).join(', '))

// 2. 检查 v5 新增的表
const tables = ['license_records', 'app_config', 'field_keys']
for (const t of tables) {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
  console.log(`[table] ${t}: ${exists ? '✅ 存在' : '❌ 缺失'}`)
}

// 3. 检查 providers.api_key_cipher 列
const pragma = db.prepare("PRAGMA table_info(providers)").all()
const hasCipher = pragma.some(c => c.name === 'api_key_cipher')
console.log('[column] providers.api_key_cipher:', hasCipher ? '✅ 存在' : '❌ 缺失')

db.close()

// 4. 测试 License 验签流程
console.log('\n--- License 验签测试 ---')

// 用刚才生成的私钥签发一个测试 license
const privateKey = fs.readFileSync(path.join(__dirname, '..', 'build', 'license-private.pem'), 'utf8')
const now = Date.now()
const expires = now + 365 * 24 * 60 * 60 * 1000 // 1 年

const payload = {
  version: 1,
  license_id: 'LIC-TEST-0001',
  owner: '测试用户',
  issued_at: now,
  expires_at: expires,
  plan: 'pro',
  features: ['mcp', 'agent', 'backup', 'encryption', 'multi-runtime']
}

// 规范化 + 签名
const SIGN_FIELDS = ['expires_at', 'features', 'issued_at', 'license_id', 'owner', 'plan', 'version']
const signedData = SIGN_FIELDS.map(k => {
  const v = payload[k]
  if (Array.isArray(v)) return `${k}=${JSON.stringify(v.slice().sort())}`
  return `${k}=${String(v)}`
}).join('&')

const sign = crypto.createSign('RSA-SHA256')
sign.update(signedData)
sign.end()
const signature = sign.sign(privateKey).toString('base64')

const licenseFile = JSON.stringify({ ...payload, signature }, null, 2)
const licensePath = path.join(__dirname, '..', 'build', 'test-license.lic')
fs.writeFileSync(licensePath, licenseFile)
console.log('[license] 已生成:', licensePath)

// 现在用应用里的公钥验签（从 generate-license-key.js 输出复制）
const publicKeyB64 = 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAqptuxYXOx+71Z4orwU+O/J6FjXa76E5Ot6cIv2NfAD1tmyD7eOH0fM9db05kuVawNQUldCeQLmhPNTNT3HekRhxWVNjISdNYfuJ5TldUasrbK/emLipMj3UWNiCNL0UYzoCp47TRclAGFDyvLyi/hFZ4lcyiakQruhRLaPE7pT0ecqkEoKXOLGY1gkNGxGBhJpejXOsfs2SfNwH+4fpMMZn2haCc+tm9Mf83YQLSeAncyn1zSh/5JyyB2UwyefxrBoxriHzzvjMYlZYvZ/YWLIXsc7z7I8tiVUA0deAtDWlBFFwdkI7NCLMWVt9kJLBTSDbjkqwckBfushpSXmHp3wIDAQAB'
const pubKey = `-----BEGIN PUBLIC KEY-----\n${publicKeyB64}\n-----END PUBLIC KEY-----`

const verify = crypto.createVerify('RSA-SHA256')
verify.update(signedData)
verify.end()
const ok = verify.verify(pubKey, Buffer.from(signature, 'base64'))
console.log('[verify] 签名校验:', ok ? '✅ 通过' : '❌ 失败')

// 5. 测试篡改检测
const tampered = JSON.parse(licenseFile)
tampered.owner = '黑客用户'
const tamperedData = SIGN_FIELDS.map(k => {
  const v = tampered[k]
  if (Array.isArray(v)) return `${k}=${JSON.stringify(v.slice().sort())}`
  return `${k}=${String(v)}`
}).join('&')
const verify2 = crypto.createVerify('RSA-SHA256')
verify2.update(tamperedData)
verify2.end()
const ok2 = verify2.verify(pubKey, Buffer.from(tampered.signature, 'base64'))
console.log('[tamper] 篡改后验签:', ok2 ? '❌ 未被检测！' : '✅ 正确拒绝')

try { app.quit() } catch (e) { process.exit(0) }
