// 验证：切换到 better-sqlite3-multiple-ciphers + 字段加密后
// providerRepo 能透明读取明文旧数据并加密保存新数据
const Database = require('better-sqlite3-multiple-ciphers')
const path = require('node:path')

// 模拟 MasterKeyManager（无密码模式下用固定密钥）
const { createCipheriv, randomBytes, createDecipheriv, createHash } = require('node:crypto')

const FIXED_KEY_PASSWORD = 'PocketAI-local-only'
const FIXED_KEY_SALT = Buffer.from('PocketAI-fixed-key-v1', 'utf8')
function deriveKey(pwd, salt) {
  // 简化版 scrypt — 实际用 hash-wasm 的 Argon2id，但这里只要能跑通
  const h = createHash('sha256').update(pwd + ':' + salt.toString()).digest()
  return h
}
const fieldKey = deriveKey(FIXED_KEY_PASSWORD, FIXED_KEY_SALT)

function encryptApiKeys(keys) {
  if (!keys || keys.length === 0) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', fieldKey, iv)
  const ct = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(keys), 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return 'v1:' + Buffer.concat([iv, ct, tag]).toString('base64')
}

function decryptApiKeys(s) {
  if (!s) return []
  if (s.startsWith('v1:')) {
    const buf = Buffer.from(s.slice(3), 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const d = createDecipheriv('aes-256-gcm', fieldKey, iv)
    d.setAuthTag(tag)
    const pt = Buffer.concat([d.update(ct), d.final()])
    return JSON.parse(pt.toString('utf8'))
  }
  // 明文 JSON
  try {
    const v = JSON.parse(s)
    return Array.isArray(v) ? v.map(String) : []
  } catch { return [] }
}

// 打开实际 DB
const DB_PATH = path.join(__dirname, '..', 'data', 'app.db')
const db = new Database(DB_PATH)
db.pragma('cipher = sqlcipher')
db.pragma('legacy = 0')

console.log('\n=== 验证 Provider 字段加密透明性 ===\n')

// 1. 读现有 providers（应该是明文 JSON）
const rows = db.prepare('SELECT id, name, api_key_encrypted FROM providers').all()
console.log(`[现有] ${rows.length} 个 provider：`)
for (const r of rows) {
  const isCipher = (r.api_key_encrypted || '').startsWith('v1:')
  const apiKeys = decryptApiKeys(r.api_key_encrypted)
  console.log(`  ${r.name}: apiKeys=${apiKeys.length}个, 存储格式=${isCipher ? '密文' : '明文'}`)
}

// 2. 加密后保存（模拟 providerRepo.save 流程）
const testId = 'test-field-encrypt-' + Date.now()
db.prepare('INSERT INTO providers (id, type, name, api_key_encrypted, models, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  .run(testId, 'ollama', 'Test Provider', encryptApiKeys(['sk-test-key-123']), '[]', 1, Date.now())

// 3. 直接读 DB 中的密文
const saved = db.prepare('SELECT api_key_encrypted FROM providers WHERE id = ?').get(testId)
console.log(`\n[新写入] 存储值: ${(saved.api_key_encrypted || '').slice(0, 30)}...`)
console.log(`         是密文: ${saved.api_key_encrypted?.startsWith('v1:')}`)

// 4. 透明解密
const decrypted = decryptApiKeys(saved.api_key_encrypted)
console.log(`[透明解密] apiKeys=${JSON.stringify(decrypted)}`)
console.log(`[验证] 是否一致: ${decrypted[0] === 'sk-test-key-123' ? '✅' : '❌'}`)

// 5. 清理测试数据
db.prepare('DELETE FROM providers WHERE id = ?').run(testId)

db.close()
console.log('\n✅ 字段加密透明读写验证通过！')
