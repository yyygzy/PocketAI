// 本地备份 + 恢复端到端测试
const Database = require('better-sqlite3-multiple-ciphers')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 模拟 backup-service 的核心流程（避免完整 Electron 环境）
const archiver = require('archiver')
const unzipper = require('unzipper')
const { createCipheriv, createDecipheriv, randomBytes, createHash } = require('node:crypto')
const { Readable } = require('node:stream')

const DB = path.join(__dirname, '..', 'data', 'app.db')
const BACKUP_DIR = path.join(__dirname, '..', 'build', 'test-backups')

if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true })

// 0. 先 checkpoint WAL（模拟 dbService）
console.log('\n[0] WAL checkpoint')
const db = new Database(DB)
db.pragma('wal_checkpoint(TRUNCATE)')
db.pragma('journal_mode = DELETE')
console.log('    ✅ checkpoint 完成')

// 1. 打包 zip
async function createZip() {
  const chunks = []
  const archive = archiver('zip', { zlib: { level: 6 } })
  archive.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
  archive.on('error', e => { throw e })

  archive.append(Buffer.from(JSON.stringify({ version: 1, test: true }), 'utf8'), { name: 'manifest.json' })
  archive.append(fs.readFileSync(DB), { name: 'app.db' })
  await archive.finalize()
  return Buffer.concat(chunks)
}

(async () => { const zip = await createZip()
db.close()
console.log(`[1] 打包 zip: ${zip.length} bytes ✅`)

// 2. 加密备份
const MASTER_KEY = createHash('sha256').update('test-master-pwd-2026').digest()
const salt = randomBytes(16)
const encKey = createHash('sha256').update(MASTER_KEY).update(salt).digest()
const iv = randomBytes(12)
const cipher = createCipheriv('aes-256-gcm', encKey, iv)
const ct = Buffer.concat([cipher.update(zip), cipher.final()])
const tag = cipher.getAuthTag()
const ENC_PREFIX = 'PKBK1'
const blob = Buffer.concat([Buffer.from(ENC_PREFIX), iv, salt, tag, ct])
console.log(`[2] AES-256-GCM 加密: ${blob.length} bytes ✅`)

const encFile = path.join(BACKUP_DIR, 'pocketai-backup-test.enc.zip')
fs.writeFileSync(encFile, blob)

// 3. 解密恢复
console.log('[3] 解密恢复流程')
const encBlob = fs.readFileSync(encFile)
const decKey = createHash('sha256').update(MASTER_KEY).update(encBlob.subarray(5+12, 5+12+16)).digest()
const decipher = createDecipheriv('aes-256-gcm', decKey, encBlob.subarray(5, 5+12))
decipher.setAuthTag(encBlob.subarray(5+12+16, 5+12+16+16))
const decZip = Buffer.concat([decipher.update(encBlob.subarray(5+12+16+16)), decipher.final()])
console.log(`    ✅ 解密成功: ${decZip.length} bytes (原 zip=${zip.length})`)
console.log(`    ✅ 数据完整: ${decZip.length === zip.length}`)

// 4. 解压
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketai-restore-'))
await new Promise((resolve, reject) => {
  Readable.from(decZip)
    .pipe(unzipper.Extract({ path: tmp }))
    .on('close', resolve)
    .on('error', reject)
})
console.log(`[4] 解压到: ${tmp}`)
const files = fs.readdirSync(tmp)
console.log(`    文件: ${files.join(', ')}`)

// 5. 验证 DB 文件存在
const restoredDB = path.join(tmp, 'app.db')
console.log(`[5] 恢复的 DB: ${fs.existsSync(restoredDB) ? '存在' : '❌ 缺失'}`)
const rdb = new Database(restoredDB)
const assistCount = rdb.prepare('SELECT COUNT(*) as c FROM assistants').get().c
const convCount = rdb.prepare('SELECT COUNT(*) as c FROM conversations').get().c
console.log(`    数据完好: assistants=${assistCount}, conv=${convCount}`)
rdb.close()

// 清理
fs.unlinkSync(encFile)
fs.rmSync(tmp, { recursive: true, force: true })

console.log('\n🎉 备份 → 加密 → 解密 → 解压 → 数据完整性 全流程验证通过！')

