#!/usr/bin/env node
// asar 增量更新补丁生成脚本（发布侧）
//
// 用法：
//   node scripts/make-asar-patch.js --old <旧app.asar> --new <新app.asar> --old-version 1.2.0 --new-version 1.3.0 [--out dist-patch]
//
// 产物：asar-patch-{oldVer}-{newVer}.json.gz —— 上传到 GitHub Release 资产，
// 应用侧通过 releases/latest/download/{name} 重定向直接下载。
//
// 原理：64KB 定长块 + sha256 内容寻址。旧 asar 切块建索引，新 asar 逐块查表：
// 命中 → 引用旧块索引；未命中 → 内嵌 base64。应用侧按序重建并校验两次 sha256。
// 安全：RSA-SHA256 签名（复用 license 密钥体系，公钥内置），防止补丁被篡改后注入代码。
const { createHash, createSign } = require('node:crypto')
const { gzipSync } = require('node:zlib')
const fs = require('node:fs')
const path = require('node:path')

const BLOCK_SIZE = 64 * 1024
const FORMAT = 1
// 签名字段序 —— 必须与 src/main/update/asar-patcher.ts 的 canonicalize 完全一致
const SIGN_FIELDS = [
  'blockSize', 'chunksSha256', 'format', 'newSha256',
  'newSize', 'newVersion', 'oldSha256', 'oldVersion'
]

function arg(name) {
  const i = process.argv.indexOf('--' + name)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null
}

const oldPath = arg('old')
const newPath = arg('new')
const oldVersion = arg('old-version')
const newVersion = arg('new-version')
if (!oldPath || !newPath || !oldVersion || !newVersion) {
  console.error('用法: node scripts/make-asar-patch.js --old <旧asar> --new <新asar> --old-version x.y.z --new-version a.b.c [--out 目录] [--key 私钥路径]')
  process.exit(1)
}

const keyPath = arg('key') || path.join(__dirname, '..', 'build', 'license-private.pem')
if (!fs.existsSync(keyPath)) {
  console.error(`缺少签名私钥 ${keyPath}（scripts/generate-license-key.js 生成，仅发布侧保存）`)
  process.exit(1)
}

const oldBuf = fs.readFileSync(oldPath)
const newBuf = fs.readFileSync(newPath)
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

// ── 旧文件切块索引：hash → [块索引...] ──
const oldIndex = new Map()
for (let i = 0, n = 0; i < oldBuf.length; i += BLOCK_SIZE, n++) {
  const h = sha256(oldBuf.subarray(i, Math.min(i + BLOCK_SIZE, oldBuf.length)))
  let list = oldIndex.get(h)
  if (!list) { list = []; oldIndex.set(h, list) }
  list.push(n)
}

// ── 新文件逐块 diff ──
const chunks = []
const oldBlockCache = new Map() // 块索引 → Buffer（重建侧按索引取旧块时保持一致）
for (let i = 0, n = 0; i < newBuf.length; i += BLOCK_SIZE, n++) {
  const block = newBuf.subarray(i, Math.min(i + BLOCK_SIZE, newBuf.length))
  const h = sha256(block)
  const list = oldIndex.get(h)
  if (list && list.length > 0) {
    // 命中：引用旧块（多次命中同一块时按消费顺序取不同索引，保证重建侧顺序正确）
    chunks.push({ r: list.shift() })
  } else {
    chunks.push({ d: block.toString('base64') })
  }
}

const chunksSha256 = sha256(Buffer.from(JSON.stringify(chunks), 'utf8'))
const payload = {
  format: FORMAT,
  oldVersion,
  newVersion,
  blockSize: BLOCK_SIZE,
  oldSha256: sha256(oldBuf),
  newSha256: sha256(newBuf),
  newSize: newBuf.length,
  chunksSha256,
  chunks
}

// ── 签名（对去 chunks 的规范串 + chunksSha256）──
const canonicalize = (p) =>
  SIGN_FIELDS.map((k) => `${k}=${String(p[k])}`).join('&')
const sign = createSign('RSA-SHA256')
sign.update(canonicalize(payload))
sign.end()
payload.sig = sign.sign(fs.readFileSync(keyPath, 'utf8'), 'base64')

// ── gzip 落盘 ──
const outDir = arg('out') || path.join(__dirname, '..', 'dist-patch')
fs.mkdirSync(outDir, { recursive: true })
const fileName = `asar-patch-${oldVersion}-${newVersion}.json.gz`
const outPath = path.join(outDir, fileName)
fs.writeFileSync(outPath, gzipSync(Buffer.from(JSON.stringify(payload), 'utf8')))

const newBlocks = chunks.filter((c) => c.d !== undefined).length
const reused = chunks.length - newBlocks
const fullSize = newBuf.length
const patchSize = fs.statSync(outPath).size
console.log(`补丁已生成: ${outPath}`)
console.log(`块统计: 复用 ${reused} / 新增 ${newBlocks}（块大小 ${BLOCK_SIZE / 1024}KB）`)
console.log(`大小: 补丁 ${(patchSize / 1024 / 1024).toFixed(2)}MB vs 全量 asar ${(fullSize / 1024 / 1024).toFixed(2)}MB（${((1 - patchSize / fullSize) * 100).toFixed(1)}% 节省）`)
console.log('上传到 GitHub Release 资产即可被客户端增量发现。')
