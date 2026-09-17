// 一次性脚本：给 asst-coder 开启全部工具权限，方便 Agent 测试
const { app } = require('electron')
const path = require('node:path')
const Database = require('better-sqlite3')

const DB_PATH = path.join(__dirname, '..', 'data', 'app.db')
const db = new Database(DB_PATH, { fileMustExist: true })
db.pragma('journal_mode = WAL')

const r = db.prepare('UPDATE assistants SET tool_permissions = ? WHERE id = ?').run(
  JSON.stringify(['*']),
  'asst-coder'
)
console.log('[update] changes =', r.changes)

const a = db.prepare("SELECT id, name, tool_permissions, system_prompt FROM assistants WHERE id = 'asst-coder'").get()
console.log('  id               =', a.id)
console.log('  name             =', a.name)
console.log('  tool_permissions =', a.tool_permissions)
console.log('  system_prompt    =', (a.system_prompt || '').slice(0, 80) + '...')

db.close()
try { app.quit() } catch (e) { process.exit(0) }
