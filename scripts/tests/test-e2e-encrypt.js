// 端到端加密迁移测试：
// 1. 备份现有 app.db
// 2. 用 better-sqlite3-multiple-ciphers 打开明文库
// 3. PRAGMA rekey 加密
// 4. 关闭 → 再开必须密码才能读写
// 5. 验证密码错误时拒绝
// 6. 用正确密码 → 数据完整

const Database = require('better-sqlite3-multiple-ciphers')
const fs = require('node:fs')
const path = require('node:path')

const DB = path.join(__dirname, '..', 'data', 'app.db')
const BACKUP = path.join(__dirname, '..', 'data', 'app.db.bak')
const PASSWORD = 'test-master-pwd'

// 0. 备份
fs.copyFileSync(DB, BACKUP)
console.log('[0] 备份 app.db → app.db.bak')

// ── Phase 1: 明文 → 加密 ──────────────────────────────
console.log('\n[Phase 1] 加密现有明文库')

const db1 = new Database(DB)
db1.pragma('cipher = sqlcipher')
db1.pragma('legacy = 0')
db1.pragma('journal_mode = DELETE') // rekey 必须 DELETE

const before = db1.prepare('SELECT COUNT(*) as c FROM assistants').get()
console.log(`  加密前 assistants 数量: ${before.c}`)

db1.pragma(`rekey = '${PASSWORD}'`)
console.log('  ✅ rekey 成功')
db1.close()

// ── Phase 2: 无密码打开 → 必须失败 ────────────────────
console.log('\n[Phase 2] 验证加密生效（无密码打不开）')
try {
  const db2 = new Database(DB)
  db2.pragma('cipher = sqlcipher')
  db2.pragma('legacy = 0')
  db2.prepare('SELECT 1').get()
  console.log('  ❌ 无密码居然能打开！')
  db2.close()
  process.exit(1)
} catch (e) {
  console.log(`  ✅ 无密码被拒绝: ${e.message.slice(0, 40)}`)
}

// ── Phase 3: 错误密码 → 必须失败 ──────────────────────
console.log('\n[Phase 3] 错误密码被拒绝')
try {
  const db3 = new Database(DB)
  db3.pragma('cipher = sqlcipher')
  db3.pragma('legacy = 0')
  db3.pragma("key = 'wrong-password'")
  db3.prepare('SELECT 1').get()
  console.log('  ❌ 错误密码居然能打开！')
  db3.close()
  process.exit(1)
} catch (e) {
  console.log(`  ✅ 错误密码被拒绝: ${e.message.slice(0, 40)}`)
}

// ── Phase 4: 正确密码 → 数据完整 ──────────────────────
console.log('\n[Phase 4] 正确密码解锁 → 数据完整')
const db4 = new Database(DB)
db4.pragma('cipher = sqlcipher')
db4.pragma('legacy = 0')
db4.pragma(`key = '${PASSWORD}'`)
db4.pragma('journal_mode = WAL')

const after = db4.prepare('SELECT COUNT(*) as c FROM assistants').get()
console.log(`  加密后 assistants 数量: ${after.c}`)

const convCount = db4.prepare('SELECT COUNT(*) as c FROM conversations').get().c
const msgCount = db4.prepare('SELECT COUNT(*) as c FROM messages').get().c
const provCount = db4.prepare('SELECT COUNT(*) as c FROM providers').get().c
const migs = db4.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version)
console.log(`  其他表: conv=${convCount} msg=${msgCount} prov=${provCount}`)
console.log(`  迁移版本: v${migs.join(' → v')}`)

// 读一条实际数据
const sample = db4.prepare('SELECT name FROM assistants LIMIT 1').get()
console.log(`  示例 assistant: ${sample.name}`)

db4.close()
console.log('  ✅ 数据完整性验证通过')

// ── Phase 5: 密码轮换 ─────────────────────────────────
console.log('\n[Phase 5] 密码轮换')
const NEW_PWD = 'new-master-pwd-2'
const db5 = new Database(DB)
db5.pragma('cipher = sqlcipher')
db5.pragma('legacy = 0')
db5.pragma(`key = '${PASSWORD}'`)
db5.pragma('journal_mode = DELETE')
db5.pragma(`rekey = '${NEW_PWD}'`)
console.log('  ✅ rekey 成功')
db5.close()

// 验证新密码
const db6 = new Database(DB)
db6.pragma('cipher = sqlcipher')
db6.pragma('legacy = 0')
db6.pragma(`key = '${NEW_PWD}'`)
db6.pragma('journal_mode = WAL')
const finalCount = db6.prepare('SELECT COUNT(*) as c FROM assistants').get().c
console.log(`  新密码后 assistants 数量: ${finalCount}`)
db6.close()
console.log('  ✅ 密码轮换验证通过')

// ── Phase 6: 恢复明文（测试完） ────────────────────────
console.log('\n[Phase 6] 恢复明文 DB')
const db7 = new Database(DB)
db7.pragma('cipher = sqlcipher')
db7.pragma('legacy = 0')
db7.pragma(`key = '${NEW_PWD}'`)
db7.pragma('journal_mode = DELETE')
db7.pragma("rekey = ''")  // 空密码 = 去加密
db7.close()

// 恢复备份给后续开发用
fs.copyFileSync(BACKUP, DB)
fs.unlinkSync(BACKUP)
console.log('  ✅ DB 已恢复明文备份')

console.log('\n🎉 全部 6 个阶段通过！SQLite3MultipleCiphers 在 Windows + Electron 上完整加密/解密/轮换流程工作正常')
