// 一次性脚本：查询 providers，避免 Electron cleanup 触发沙箱
const path = require('node:path')
const Database = require('better-sqlite3')

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db')
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })

const providers = db.prepare('SELECT id, name, type, base_url, enabled, models FROM providers').all()
console.log('[providers] count:', providers.length)
for (const p of providers) {
  console.log(`  - ${p.id} | ${p.name} | ${p.type} | ${p.base_url} | enabled=${p.enabled} | models=${(p.models ?? '').slice(0, 100)}`)
}

const assistants = db.prepare('SELECT id, name FROM assistants WHERE is_builtin=0').all()
console.log('[custom assistants] count:', assistants.length)
for (const a of assistants) {
  console.log(`  - ${a.id} | ${a.name}`)
}

const conversations = db.prepare('SELECT id, title, status FROM conversations ORDER BY created_at DESC LIMIT 5').all()
console.log('[recent conversations] count:', conversations.length)
for (const c of conversations) {
  console.log(`  - ${c.id} | ${c.title} | ${c.status}`)
}

db.close()
process.exit(0)
