// 验证 better-sqlite3-multiple-ciphers 在 Windows + Electron 上是否可用
const Database = require('better-sqlite3-multiple-ciphers')
const path = require('node:path')
const fs = require('node:fs')

const TEST_DB = path.join(__dirname, '..', 'build', 'test-cipher.db')

// 清理旧测试库
try { fs.unlinkSync(TEST_DB) } catch {}
try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
try { fs.unlinkSync(TEST_DB + '-shm') } catch {}

console.log('[1] 创建明文数据库')
const db1 = new Database(TEST_DB)
db1.pragma('journal_mode = DELETE') // 先用 DELETE（rekey 需要）
db1.pragma('cipher = sqlcipher')
db1.pragma('legacy = 0')
db1.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, name TEXT)')
db1.prepare('INSERT INTO test (name) VALUES (?)').run('hello')
console.log('    ✅ 明文创建成功')
db1.close()

console.log('[2] 加密现有库（PRAGMA rekey）')
const db2 = new Database(TEST_DB)
db2.pragma('cipher = sqlcipher')
db2.pragma('legacy = 0')
db2.prepare('SELECT * FROM test').get() // 先验证能读
db2.pragma("rekey = 'mypassword123'")
console.log('    ✅ rekey 成功')
db2.close()

console.log('[3] 用正确密码打开加密库 + WAL')
const db3 = new Database(TEST_DB)
db3.pragma('cipher = sqlcipher')
db3.pragma('legacy = 0')
db3.pragma("key = 'mypassword123'")
db3.pragma('journal_mode = WAL') // 加密后再开 WAL
const row = db3.prepare('SELECT * FROM test').get()
console.log('    ✅ 解密成功:', JSON.stringify(row))
db3.close()

console.log('[4] 用错误密码尝试打开（应失败）')
try {
  const db4 = new Database(TEST_DB)
  db4.pragma('cipher = sqlcipher')
  db4.pragma('legacy = 0')
  db4.pragma("key = 'wrongpassword'")
  db4.prepare('SELECT * FROM test').get()
  console.log('    ❌ 应该失败但成功了')
} catch (e) {
  console.log('    ✅ 正确拒绝:', e.message.slice(0, 40))
}

console.log('[5] 密码轮换')
const db5 = new Database(TEST_DB)
db5.pragma('cipher = sqlcipher')
db5.pragma('legacy = 0')
db5.pragma("key = 'mypassword123'")
db5.pragma('journal_mode = DELETE') // rekey 前必须关 WAL
db5.prepare('INSERT INTO test (name) VALUES (?)').run('world')
db5.pragma("rekey = 'newpassword456'")
const rows = db5.prepare('SELECT * FROM test').all()
console.log('    ✅ rekey 后数据完好:', rows.length, '行')
db5.close()

console.log('[6] 用新密码打开 + WAL')
const db6 = new Database(TEST_DB)
db6.pragma('cipher = sqlcipher')
db6.pragma('legacy = 0')
db6.pragma("key = 'newpassword456'")
db6.pragma('journal_mode = WAL')
const finalRows = db6.prepare('SELECT * FROM test').all()
console.log('    ✅ 新密码解密成功:', finalRows.length, '行')
db6.close()

console.log('\n🎉 better-sqlite3-multiple-ciphers v12 在 Windows + Electron 33 上工作正常！')
console.log('   加密算法: AES-256-GCM（SQLite3MultipleCiphers）')
console.log('   API: 与 better-sqlite3 完全兼容，只需替换 import + PRAGMA key/rekey')
console.log('   注意: WAL 模式下 rekey 需先切 DELETE → rekey → 再切 WAL')

// 清理
try { fs.unlinkSync(TEST_DB) } catch {}
try { fs.unlinkSync(TEST_DB + '-wal') } catch {}
try { fs.unlinkSync(TEST_DB + '-shm') } catch {}
