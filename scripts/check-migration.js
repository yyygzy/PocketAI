// 一次性脚本：通过 Electron 的 Node 运行时查询 DB 验证 Phase 3 迁移
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'app.db')

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true })
db.pragma('journal_mode = WAL')

const migs = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version').all()
console.log('[migrations] applied:', JSON.stringify(migs))

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name)
console.log('[tables]:', tables.join(', '))

const mcpCount = db.prepare('SELECT COUNT(*) as c FROM mcp_servers').get()
console.log('[mcp_servers] count:', mcpCount.c)

const assistants = db.prepare('SELECT id, name, tool_permissions FROM assistants').all()
console.log('[assistants] (showing tool_permissions):')
for (const a of assistants) {
  console.log(`  - ${a.id} ${a.name} | tool_permissions=${a.tool_permissions ?? 'NULL'}`)
}

const providers = db.prepare('SELECT id, name, enabled, models FROM providers').all()
console.log('[providers]:')
for (const p of providers) {
  console.log(`  - ${p.id} ${p.name} enabled=${p.enabled} models=${(p.models ?? '').slice(0, 80)}`)
}

db.close()
app.quit()
