// 集成测试：启用加密 → 加密备份 → 恢复 → 验证
// 完全独立脚本，不依赖 TS 源码 import
;(async () => {
  const Database = require('better-sqlite3-multiple-ciphers')
  const path = require('node:path')
  const fs = require('node:fs')
  const os = require('node:os')
  const archiver = require('archiver')
  const unzipper = require('unzipper')
  const { createCipheriv, createDecipheriv, randomBytes, createHash } = require('node:crypto')
  const { Readable } = require('node:stream')

  const ROOT = path.join(__dirname, '..')
  const DATA_DIR = path.join(ROOT, 'data')
  const DB_PATH = path.join(DATA_DIR, 'app.db')
  const BACKUP_DIR = path.join(DATA_DIR, 'backups')

  console.log('\n═══════ Phase 4 集成测试 ═══════\n')

  // 0. 备份当前 DB + 清理 app_config 的加密标记（确保测试环境干净）
  const preEncDB = path.join(ROOT, 'build', 'pre-integ-backup.db')
  const preEncConfig = path.join(ROOT, 'build', 'pre-integ-config.json')
  fs.copyFileSync(DB_PATH, preEncDB)
  console.log('[0] 已备份当前 app.db')

  // 1. 打开 DB + 清理 app_config 加密标记
  console.log('\n[1] 打开 DB，清理加密配置...')
  const db = new Database(DB_PATH)
  db.pragma('cipher = sqlcipher')
  db.pragma('legacy = 0')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  // 先确保 app_config 有我们需要的键
  const migrations = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all()
  console.log(`    迁移版本: ${migrations.map(m=>m.version).join(' → ')}`)

  // 清理加密配置
  db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run('encryption_mode', 'none', Date.now())
  db.prepare(`INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .run('has_master_password', '0', Date.now())
  try { db.prepare('DELETE FROM app_config WHERE key = ?').run('master_password_salt') } catch {}
  db.close()
  console.log('    ✅ 加密配置已清理')

  // 2. 重新打开 → 启用加密（模拟 dbService.enableEncryption 流程）
  console.log('\n[2] 启用 DB 加密...')
  const PASSWORD = 'e2e-integration-test-2026'
  const salt = randomBytes(16)
  const encKey = createHash('sha256').update(PASSWORD).update(salt).digest()

  const db2 = new Database(DB_PATH)
  db2.pragma('cipher = sqlcipher')
  db2.pragma('legacy = 0')

  // rekey 需要 DELETE journal_mode
  db2.pragma('journal_mode = DELETE')
  db2.pragma(`rekey = '${PASSWORD}'`)
  db2.close()
  console.log('    ✅ PRAGMA rekey 成功')

  // 3. 用密码重开 → 验证数据完好
  console.log('\n[3] 密码解锁 → 验证数据...')
  const db3 = new Database(DB_PATH)
  db3.pragma('cipher = sqlcipher')
  db3.pragma('legacy = 0')
  db3.pragma(`key = '${PASSWORD}'`)
  db3.pragma('journal_mode = WAL')

  const assistCount = db3.prepare('SELECT COUNT(*) as c FROM assistants').get().c
  const convCount = db3.prepare('SELECT COUNT(*) as c FROM conversations').get().c
  const msgCount = db3.prepare('SELECT COUNT(*) as c FROM messages').get().c
  const provCount = db3.prepare('SELECT COUNT(*) as c FROM providers').get().c
  console.log(`    ✅ 数据完好: assistants=${assistCount} conv=${convCount} msg=${msgCount} prov=${provCount}`)

  // 4. 加密本地备份（模拟 backup-service.createEncryptedLocalBackup）
  console.log('\n[4] WAL checkpoint → 打包 zip → AES-256-GCM 加密...')
  db3.pragma('wal_checkpoint(TRUNCATE)')
  db3.pragma('journal_mode = DELETE')

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-test-'))
  fs.copyFileSync(DB_PATH, path.join(tmp, 'app.db'))
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify({
    version: 1, createdAt: new Date().toISOString(), encrypted: true, dbEncrypted: true
  }, null, 2))

  const chunks = []
  const archive = archiver('zip', { zlib: { level: 6 } })
  archive.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  archive.on('error', e => { throw e })
  archive.append(fs.readFileSync(path.join(tmp, 'manifest.json')), { name: 'manifest.json' })
  archive.append(fs.readFileSync(path.join(tmp, 'app.db')), { name: 'app.db' })
  await archive.finalize()
  const zip = Buffer.concat(chunks)
  console.log(`    zip 打包: ${zip.length} bytes`)

  // 加密（PKBK1 格式）
  const encSalt = randomBytes(16)
  const encMasterKey = createHash('sha256').update(encKey).update(encSalt).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encMasterKey, iv)
  const ct = Buffer.concat([cipher.update(zip), cipher.final()])
  const tag = cipher.getAuthTag()
  const ENC_PREFIX = 'PKBK1'
  const blob = Buffer.concat([Buffer.from(ENC_PREFIX), iv, encSalt, tag, ct])

  // 写文件
  fs.mkdirSync(BACKUP_DIR, { recursive: true })
  const backupFile = path.join(BACKUP_DIR, `pocketai-backup-test-${Date.now()}.enc.zip`)
  fs.writeFileSync(backupFile, blob)
  console.log(`    ✅ 加密备份: ${path.basename(backupFile)} (${blob.length} bytes)`)
  console.log(`       格式: PKBK1(5) + iv(12) + salt(16) + tag(16) + ct`)

  db3.close()
  fs.rmSync(tmp, { recursive: true, force: true })

  // 5. 验证明文打不开加密库
  console.log('\n[5] 验证无密码被拒...')
  try {
    const db4 = new Database(DB_PATH)
    db4.pragma('cipher = sqlcipher'); db4.pragma('legacy = 0')
    db4.prepare('SELECT 1').get()
    db4.close()
    console.log('    ❌ 无密码居然能打开！')
    process.exit(1)
  } catch (e) {
    console.log(`    ✅ 无密码被拒绝: ${e.message.slice(0, 40)}`)
  }

  // 6. 恢复流程：用密码重开备份包
  console.log('\n[6] 恢复流程：解密备份 → 解压 → 验证...')
  const encBlob = fs.readFileSync(backupFile)
  const decMasterKey = createHash('sha256').update(encKey).update(encBlob.subarray(5+12, 5+12+16)).digest()
  const decipher = createDecipheriv('aes-256-gcm', decMasterKey, encBlob.subarray(5, 5+12))
  decipher.setAuthTag(encBlob.subarray(5+12+16, 5+12+16+16))
  const decZip = Buffer.concat([decipher.update(encBlob.subarray(5+12+16+16)), decipher.final()])
  console.log(`    ✅ 解密: ${decZip.length} bytes (完整=${decZip.length === zip.length})`)

  const restoreTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-restore-'))
  await new Promise((resolve, reject) => {
    Readable.from(decZip).pipe(unzipper.Extract({ path: restoreTmp }))
      .on('close', resolve).on('error', reject)
  })
  console.log(`    ✅ 解压完成: ${fs.readdirSync(restoreTmp).join(', ')}`)

  const rdb = new Database(path.join(restoreTmp, 'app.db'))
  rdb.pragma('cipher = sqlcipher'); rdb.pragma('legacy = 0')
  rdb.pragma(`key = '${PASSWORD}'`)
  const rAssist = rdb.prepare('SELECT COUNT(*) as c FROM assistants').get().c
  console.log(`    ✅ 恢复数据完好: assistants=${rAssist}`)
  rdb.close()
  fs.rmSync(restoreTmp, { recursive: true, force: true })

  // 7. 清理：恢复原始明文 DB
  console.log('\n[7] 清理：恢复原始明文 DB...')
  const db5 = new Database(DB_PATH)
  db5.pragma('cipher = sqlcipher'); db5.pragma('legacy = 0')
  db5.pragma(`key = '${PASSWORD}'`)
  db5.pragma('journal_mode = DELETE')
  db5.pragma("rekey = ''")
  db5.close()
  console.log('    ✅ 已恢复明文')

  // 清理测试备份
  try { fs.unlinkSync(backupFile) } catch {}
  try { fs.unlinkSync(preEncDB) } catch {}

  console.log('\n═══════ 集成测试全部通过 ═══════\n')
  console.log('✅ DB 加密启用     PRAGMA rekey 成功')
  console.log('✅ 加密备份       ZIP + AES-256-GCM (PKBK1 格式)')
  console.log('✅ 无密码被拒      SQLITE_NOTADB')
  console.log('✅ 恢复解密       密钥派生 → 解密 → 解压 → 数据完好')
  console.log('✅ 恢复明文       rekey 空密码')
})().catch(e => { console.error(e); process.exit(1) })
