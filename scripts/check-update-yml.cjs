#!/usr/bin/env node
// CI post-build 校验: latest.yml / latest-mac.yml / latest-linux.yml 的 version
// 必须与 package.json version 一致, 不一致则 exit 1 阻断 Release.
// 用法: node scripts/check-update-yml.cjs [distDir]
const fs = require('node:fs')
const path = require('node:path')

const distDir = path.resolve(process.argv[2] || 'dist')

// 读 package.json version
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf-8'))
const expectedVersion = pkg.version
console.log(`[check-update-yml] package.json version: ${expectedVersion}`)

// 可能的 yml 文件名 (electron-builder 中英双语 + 各平台)
const CANDIDATES = [
  'latest.yml',       // Windows
  'latest-mac.yml',   // macOS
  'latest-linux.yml', // Linux
  '最新.yml',          // CI 中文 locale 可能生成
]

let errors = 0
for (const name of CANDIDATES) {
  const p = path.join(distDir, name)
  if (!fs.existsSync(p)) {
    console.log(`  ${name}: SKIP (not found)`)
    continue
  }
  const content = fs.readFileSync(p, 'utf-8')
  // electron-builder 生成的 yml 第一行是 "version: x.y.z"
  const m = content.match(/^version:\s*['"]?([\d.]+)['"]?/m)
  if (!m) {
    console.log(`  ${name}: FAIL (无法解析 version 字段)`)
    errors++
    continue
  }
  const actual = m[1]
  if (actual !== expectedVersion) {
    console.log(`  ${name}: FAIL (yml=${actual}, expected=${expectedVersion})`)
    errors++
  } else {
    console.log(`  ${name}: OK (${actual})`)
  }
}

// 同时检查 builder-debug.yml 和 最新.yml 是否混入 (CI Release 应排除)
for (const name of ['builder-debug.yml', '最新.yml']) {
  if (fs.existsSync(path.join(distDir, name))) {
    // latest.yml 本身就叫这个名字, 跳过
    if (name === '最新.yml') {
      console.log(`  ${name}: WARN (CI 中文 locale 生成, Release job 应排除)`)
    }
  }
}

if (errors > 0) {
  console.error(`\n❌ ${errors} 个 yml version 与 package.json 不一致!`)
  console.error('   请确认 package.json version 是否正确, 或 CI 构建是否用了正确的 commit.')
  process.exit(1)
}

console.log('\n✅ 所有 yml version 校验通过')
