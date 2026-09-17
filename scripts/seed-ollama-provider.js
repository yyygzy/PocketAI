// 一次性脚本：插入 Ollama 本地 Provider（无需 API Key）
// 使用方式：$env:ELECTRON_RUN_AS_NODE=1; npx electron scripts\seed-ollama-provider.js
const { app } = require('electron')
const path = require('node:path')
const crypto = require('node:crypto')
const Database = require('better-sqlite3')

const DATA_DIR = path.join(__dirname, '..', 'data')
const DB_PATH = path.join(DATA_DIR, 'app.db')

const db = new Database(DB_PATH, { fileMustExist: true })
db.pragma('journal_mode = WAL')

// 先清理旧 Ollama 配置（幂等）
db.prepare("DELETE FROM providers WHERE id = 'ollama-local'").run()

const now = Date.now()
const models = JSON.stringify([
  'qwen2.5:3b-instruct',
  'qwen2.5:1.5b-instruct',
  'qwen2.5-coder:1.5b'
])

db.prepare(`
  INSERT INTO providers (id, type, name, base_url, api_key_encrypted, models, enabled, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'ollama-local',
  'ollama',
  'Ollama 本地',
  'http://localhost:11434/v1',
  JSON.stringify([]),
  models,
  1,
  now
)

const row = db.prepare('SELECT * FROM providers WHERE id = ?').get('ollama-local')
console.log('[seed] inserted provider:')
console.log('  id         =', row.id)
console.log('  type       =', row.type)
console.log('  name       =', row.name)
console.log('  base_url   =', row.base_url)
console.log('  models     =', row.models)
console.log('  enabled    =', row.enabled)

// 顺手给「通用助手」开 * 权限，方便 Agent 测试
const updated = db.prepare(`
  UPDATE assistants SET tool_permissions = ? WHERE id = 'general'
`).run(JSON.stringify(['*']))
console.log('[seed] general assistant tool_permissions updated, changes =', updated.changes)

const a = db.prepare("SELECT id, name, tool_permissions FROM assistants WHERE id = 'general'").get()
console.log('  assistant  =', a.id, a.name, 'tool_permissions =', a.tool_permissions)

db.close()
app.quit()
