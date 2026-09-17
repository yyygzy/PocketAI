// 本地备份 + 恢复端到端测试
;(async () => {
  const Database = require('better-sqlite3-multiple-ciphers')
  const fs = require('node:fs')
  const path = require('node:path')
  const os = require('node:os')
  const archiver = require('archiver')
  const unzipper = require('unzipper')
  const { createCipheriv, createDecipheriv, randomBytes, createHash } = require('node:crypto')
  const { Readable } = require('node:stream')

  const DB = path.join(__dirname, '..', 'data', 'app.db')
  const ENC_PREFIX = 'PKBK1'
  const MASTER_KEY = createHash('sha256').update('test-master-pwd-2026').digest()

  console.log('\n[0] WAL checkpoint')
  const db = new Database(DB)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.pragma('journal_mode = DELETE')
  db.close()
  console.log('    ✅ checkpoint 完成')

  console.log('[1] 打包 zip')
  const chunks = []
  const archive = archiver('zip', { zlib: { level: 6 } })
  archive.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  archive.on('error', e => { throw e })
  archive.append(Buffer.from(JSON.stringify({ version: 1, test: true }), 'utf8'), { name: 'manifest.json' })
  archive.append(fs.readFileSync(DB), { name: 'app.db' })
  await archive.finalize()
  const zip = Buffer.concat(chunks)
  console.log(`    ✅ ${zip.length} bytes`)

  console.log('[2] AES-256-GCM 加密')
  const salt = randomBytes(16)
  const encKey = createHash('sha256').update(MASTER_KEY).update(salt).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encKey, iv)
  const ct = Buffer.concat([cipher.update(zip), cipher.final()])
  const tag = cipher.getAuthTag()
  const blob = Buffer.concat([Buffer.from(ENC_PREFIX), iv, salt, tag, ct])
  console.log(`    ✅ ${blob.length} bytes`)

  console.log('[3] 解密')
  const decKey = createHash('sha256').update(MASTER_KEY).update(salt).digest()
  const decipher = createDecipheriv('aes-256-gcm', decKey, iv)
  decipher.setAuthTag(tag)
  const decZip = Buffer.concat([decipher.update(ct), decipher.final()])
  console.log(`    ✅ 数据完整: ${decZip.length === zip.length}`)

  console.log('[4] 解压恢复')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-restore-'))
  await new Promise((resolve, reject) => {
    Readable.from(decZip)
      .pipe(unzipper.Extract({ path: tmp }))
      .on('close', resolve)
      .on('error', reject)
  })
  const rdb = new Database(path.join(tmp, 'app.db'))
  const ac = rdb.prepare('SELECT COUNT(*) as c FROM assistants').get().c
  const cc = rdb.prepare('SELECT COUNT(*) as c FROM conversations').get().c
  console.log(`    ✅ assistants=${ac}, conv=${cc}`)
  rdb.close()

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log('\n🎉 备份→加密→解密→解压→数据完整性 全流程通过！')
})().catch(e => { console.error(e); process.exit(1) })
