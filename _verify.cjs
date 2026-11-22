const { spawnSync } = require('child_process')
const fs = require('fs')
const out = 'verify.json'
const files = [
  'tests/kb-vec.test.ts',
  'tests/kb-js-knn-fallback.test.ts',
  'tests/kb-min-score-real-db.test.ts',
  'tests/agent-stop.test.ts',
  'tests/agent-stop-window-268.test.ts',
  'tests/ipc-stop-silent-267.test.tsx',
  'tests/audit-fixes-high.test.ts',
  'tests/audit-fixes-backup-terminal.test.ts',
  'tests/terminal-cwd.test.ts',
  'tests/task-scheduler.test.ts'
].filter((f) => fs.existsSync(f))
console.log('FILES', files.join(' '))
const r = spawnSync('npx', ['vitest', 'run', '--reporter=dot', '--reporter=json', '--outputFile.json=' + out, '--maxWorkers=2', ...files], { cwd: process.cwd(), shell: true, stdio: 'inherit' })
console.log('EXIT', r.status)
const d = JSON.parse(fs.readFileSync(out, 'utf8'))
for (const t of d.testResults) {
  const bad = (t.assertionResults || []).filter((a) => a.status === 'failed')
  console.log(t.name, t.status, 'failed', bad.length)
  for (const a of bad) console.log(' -', a.fullName, (a.failureMessages || []).join('\n').slice(0, 700))
  if (!bad.length && t.status === 'failed') console.log(' FILE MSG:', String(t.message || '').slice(0, 400))
}
