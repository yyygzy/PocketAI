const Database = require('better-sqlite3-multiple-ciphers')
const { load } = require('sqlite-vec')
const db = new Database(':memory:')
load(db)
db.exec('CREATE VIRTUAL TABLE v USING vec0(embedding float[3])')
const ins = db.prepare('INSERT INTO v(embedding) VALUES (?)')
const f = (a) => Buffer.from(new Float32Array(a).buffer)
ins.run(f([1,1,0]))
const q = f([1,1,0])
const variants = [
  ['literal LIMIT 1, IN (?)', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? AND rowid IN (?) ORDER BY distance LIMIT 1', [q,1]],
  ['bind LIMIT ?, IN (?)', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? AND rowid IN (?) ORDER BY distance LIMIT ?', [q,1,1]],
  ['k = 1, IN (?)', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? AND rowid IN (?) AND k = 1', [q,1]],
  ['k = ?, IN (?)', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? AND rowid IN (?) AND k = ?', [q,1,1]],
  ['no IN, literal LIMIT 1', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT 1', [q]],
  ['no IN, bind LIMIT ?', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? ORDER BY distance LIMIT ?', [q,1]],
  ['literal IN + literal LIMIT', 'SELECT rowid, distance FROM v WHERE embedding MATCH ? AND rowid IN (1) ORDER BY distance LIMIT 1', [q]],
]
for (const [name, sql, args] of variants) {
  try { console.log('OK ', name, JSON.stringify(db.prepare(sql).all(...args))) }
  catch (e) { console.log('ERR', name, e.message) }
}
