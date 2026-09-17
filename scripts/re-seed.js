// 重新 seed: 确保 asst-coder 的 tool_permissions=["*"]，且不再被 upsertBuiltin 覆盖
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db')
const db = new Database(DB_PATH, { fileMustExist: true })
db.pragma('journal_mode = WAL')

// 1. 确保 provider 存在（幂等）
const prov = db.prepare("SELECT id FROM providers WHERE id='ollama-local'").get()
if (!prov) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO providers (id, type, name, base_url, api_key_encrypted, models, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ollama-local',
    'ollama',
    'Ollama 本地',
    'http://localhost:11434/v1',
    JSON.stringify([]),
    JSON.stringify(['qwen2.5:3b-instruct', 'qwen2.5:1.5b-instruct', 'qwen2.5-coder:1.5b']),
    1,
    now
  )
  console.log('[seed] provider inserted')
} else {
  console.log('[seed] provider already exists')
}

// 2. 给 asst-coder 开启 * 工具权限
const r = db.prepare('UPDATE assistants SET tool_permissions = ? WHERE id = ?').run(
  JSON.stringify(['*']),
  'asst-coder'
)
console.log('[seed] asst-coder tool_permissions updated, changes =', r.changes)

// 3. 验证
const a = db.prepare("SELECT id, name, tool_permissions FROM assistants WHERE id = 'asst-coder'").get()
console.log('  verify:', a.id, a.name, 'tool_permissions =', a.tool_permissions)

const p = db.prepare("SELECT id, name, enabled FROM providers WHERE id = 'ollama-local'").get()
console.log('  provider:', p.id, p.name, 'enabled =', p.enabled)

db.close()
try { app.quit() } catch (e) { process.exit(0) }
