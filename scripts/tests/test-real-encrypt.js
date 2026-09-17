// 把 DB 用正确的方式加密：scryptSync 派生 key → PRAGMA rekey = "x'hex'"
;(async () => {
  const Database = require('better-sqlite3-multiple-ciphers')
  const path = require('node:path')
  const fs = require('node:fs')
  const { randomBytes, scryptSync } = require('node:crypto')

  const ROOT = path.join(__dirname, '..')
  const DB_PATH = path.join(ROOT, 'data', 'app.db')
  const PASSWORD = 'pocketai-real-test-123'
  const AES_KEY_LEN = 32
  const SALT_LEN = 16

  // 先杀掉所有 electron（可能还持有锁）
  console.log('[0] 清理 electron 进程...')
  // 在外部 PowerShell 执行过了，这里跳过

  // 1. 先看看当前 DB 能否打开（之前可能是明文密码加密的）
  console.log('\n[1] 检查当前 DB...')
  let db = new Database(DB_PATH)
  db.pragma('cipher = sqlcipher'); db.pragma('legacy = 0')

  // 尝试明文密码 rekey = '' 恢复明文
  try {
    db.pragma(`key = '${PASSWORD}'`)
    db.pragma('journal_mode = DELETE')
    db.pragma("rekey = ''")
    db.close()
    console.log('    ✅ 用明文密码恢复明文成功')
  } catch {
    // 可能已经是明文了
    try {
      db.prepare('SELECT COUNT(*) as c FROM assistants').get()
      console.log('    ✅ 已经是明文 DB')
      db.close()
    } catch (e2) {
      console.log(`    ❌ DB 无法打开: ${e2.message}`)
      db.close()
      process.exit(1)
    }
  }

  // 2. 生成 salt + 用 scryptSync 派生密钥（和 masterKeyManager.setKey 完全一致）
  console.log('\n[2] 生成 scryptSync 密钥...')
  const salt = randomBytes(SALT_LEN)
  const saltB64 = salt.toString('base64')
  const derivedKey = scryptSync(PASSWORD, salt, AES_KEY_LEN, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 })
  console.log(`    salt (base64): ${saltB64}`)
  console.log(`    derived key: ${derivedKey.toString('hex').slice(0, 32)}...`)

  // 3. 用 hex key 方式加密
  console.log('\n[3] PRAGMA rekey = "x\'hex\'" 加密...')
  db = new Database(DB_PATH)
  db.pragma('cipher = sqlcipher'); db.pragma('legacy = 0')
  db.pragma('journal_mode = DELETE')
  db.pragma(`rekey = "x'${derivedKey.toString('hex')}'"`)
  db.close()
  console.log('    ✅ 加密成功')

  // 4. 验证：hex key 能打开，明文密码打不开
  console.log('\n[4] 验证密钥正确性...')
  const dbTest = new Database(DB_PATH)
  dbTest.pragma('cipher = sqlcipher'); dbTest.pragma('legacy = 0')
  dbTest.pragma(`key = "x'${derivedKey.toString('hex')}'"`)
  dbTest.pragma('journal_mode = WAL')
  const c = dbTest.prepare('SELECT COUNT(*) as c FROM assistants').get().c
  console.log(`    ✅ hex key 打开成功: assistants=${c}`)
  dbTest.close()

  // 明文密码应打不开
  try {
    const dbBad = new Database(DB_PATH)
    dbBad.pragma('cipher = sqlcipher'); dbBad.pragma('legacy = 0')
    dbBad.pragma(`key = '${PASSWORD}'`)
    dbBad.prepare('SELECT 1').get()
    console.log('    ❌ 明文密码居然能打开！')
    dbBad.close()
    process.exit(1)
  } catch {
    console.log('    ✅ 明文密码被正确拒绝')
  }

  // 5. 更新 app_config
  console.log('\n[5] 更新 app_config...')
  const dbCfg = new Database(DB_PATH)
  dbCfg.pragma('cipher = sqlcipher'); dbCfg.pragma('legacy = 0')
  dbCfg.pragma(`key = "x'${derivedKey.toString('hex')}'"`)
  dbCfg.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run('encryption_mode', 'db', Date.now())
  dbCfg.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run('has_master_password', '1', Date.now())
  dbCfg.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run('master_password_salt', saltB64, Date.now())
  dbCfg.close()
  console.log('    ✅ app_config 已更新')

  console.log(`\n🔐 DB 已用 scryptSync + hex key 加密！`)
  console.log(`解锁密码: ${PASSWORD}`)
  console.log(`Salt: ${saltB64}`)
  console.log(`\n现在杀 electron-vite + electron，重启 dev server → 应该弹 unlock 窗口 → 输入密码 → 主窗口`)
})().catch(e => { console.error(e); process.exit(1) })
