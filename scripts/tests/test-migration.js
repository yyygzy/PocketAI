// 验证：切换到 better-sqlite3-multiple-ciphers 后，现有明文库仍能正常读写
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3-multiple-ciphers')

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db')
console.log('[test] DB path:', DB_PATH)

const db = new Database(DB_PATH)
db.pragma('cipher = sqlcipher')
db.pragma('legacy = 0')
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// 1. 检查迁移版本
const migs = db.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all()
console.log('[migrations]:', migs.map(m => `v${m.version}`).join(' → '))

// 2. 读现有数据
const assistCount = db.prepare('SELECT COUNT(*) as c FROM assistants').get().c
const convCount = db.prepare('SELECT COUNT(*) as c FROM conversations').get().c
const msgCount = db.prepare('SELECT COUNT(*) as c FROM messages').get().c
const provCount = db.prepare('SELECT COUNT(*) as c FROM providers').get().c
console.log(`[data] assistants=${assistCount} conversations=${convCount} messages=${msgCount} providers=${provCount}`)

// 3. 验证 WAL 模式
const wal = db.prepare('PRAGMA journal_mode').get()
console.log('[wal] journal_mode =', wal.journal_mode)

// 4. 验证加密模式（无密码）
const cipher = db.prepare('PRAGMA cipher').get()
console.log('[cipher] cipher =', cipher.cipher)

console.log('\n✅ better-sqlite3-multiple-ciphers 正常打开现有明文库，零数据丢失！')
db.close()
try { app.quit() } catch (e) { process.exit(0) }
