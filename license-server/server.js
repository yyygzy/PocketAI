#!/usr/bin/env node
// PocketAI 卡密激活服务器（零 npm 依赖，node:http 单文件）
//
// 职责：
//   1. 管理卡密（generate 生成 / unbind 解置换绑 / list 台账）
//   2. POST /v1/activate：校验卡密 + 硬盘指纹，用私钥签发绑定该指纹的 license 下发
//
// 使用方式：
//   node server.js                      # 启动服务（默认 0.0.0.0:8787，可用 HOST/PORT 环境变量覆盖）
//   node server.js generate 张三 pro 365        # 生成 1 张 1 年卡密
//   node server.js generate 张三 pro 3650 10    # 批量生成 10 张
//   node server.js generate 李四 enterprise perpetual  # 永久买断
//   node server.js unbind PA-XXXX-XXXX-XXXX    # 解绑（U 盘损坏换绑时用）
//   node server.js list                        # 查看台账
//
// 安全说明：
//   - 私钥复用发行侧 build/license-private.pem（部署时复制到服务器，务必不入 git）
//   - 卡密绑定第一个使用的硬盘后不可转移；unbind 仅供管理员处理换绑
//   - license 一经签发即存储原文，同盘重复激活幂等重发（license_id/issued_at 不变）
//   - 内存限速：单 IP 每分钟 10 次；单卡密失败 5 次锁定 10 分钟（重启清零，够用）
//   - HTTPS 交给部署层（nginx/caddy 终结 TLS）；license 本身 RSA 签名，中间人只能阻断激活

'use strict'

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..')
const DATA_FILE = path.join(__dirname, 'licenses.json')
const ISSUE = require(path.join(ROOT, 'scripts', 'lib', 'issue-license.js'))

const PORT = Number(process.env.PORT || 8787)
const HOST = process.env.HOST || '0.0.0.0'

const CODE_RE = /^PA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/
const FP_RE = /^[0-9a-f]{16}$/
// 卡密字母表：去掉易混淆的 0/O/1/I/L
const ALPHABET = '23456789ACDEFGHJKMNPQRSTUVWXYZ'

// ── 存储（licenses.json：{ codes: { CODE: {...} } }） ────────────────

function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch {
    return { codes: {} }
  }
}

// 写盘串行化 + tmp/rename 原子写：防止并发请求同时 read-modify-write 导致双绑
let writeChain = Promise.resolve()
function saveData(data) {
  writeChain = writeChain.then(() => {
    const tmp = DATA_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    fs.renameSync(tmp, DATA_FILE)
  })
  return writeChain
}

// ── 卡密生成与管理 ──────────────────────────────────────────────────

function newCode() {
  const seg = () => {
    const bytes = crypto.randomBytes(4)
    let s = ''
    for (let i = 0; i < 4; i++) s += ALPHABET[bytes[i] % ALPHABET.length]
    return s
  }
  return `PA-${seg()}-${seg()}-${seg()}`
}

function maskCode(code) {
  return code.slice(0, 5) + '-****-****'
}

function cmdGenerate(owner, plan, daysArg, countArg) {
  if (!owner) { console.error('用法: node server.js generate <owner> <pro|enterprise|free> <天数|perpetual> [数量]'); process.exit(1) }
  if (!ISSUE.PLANS.includes(plan)) { console.error(`plan 仅支持 ${ISSUE.PLANS.join(' / ')}`); process.exit(1) }
  const days = daysArg === 'perpetual' ? null : Number(daysArg)
  if (daysArg !== 'perpetual' && (!Number.isFinite(days) || days <= 0)) {
    console.error('天数应为正整数或 perpetual'); process.exit(1)
  }
  const count = Math.max(1, Math.min(500, Number(countArg || 1)))

  const data = loadData()
  const made = []
  for (let i = 0; i < count; i++) {
    let code
    do { code = newCode() } while (data.codes[code])
    data.codes[code] = {
      status: 'unused',
      owner: String(owner).trim(),
      plan,
      days, // null = 永久买断
      created_at: Date.now()
    }
    made.push(code)
  }
  saveData(data)
  console.log(`✓ 已生成 ${made.length} 张卡密（owner=${owner} plan=${plan} ${daysArg === 'perpetual' ? '永久' : days + ' 天'}）`)
  for (const c of made) console.log('  ' + c)
}

function cmdUnbind(code) {
  const c = String(code || '').trim().toUpperCase()
  if (!CODE_RE.test(c)) { console.error('卡密格式无效'); process.exit(1) }
  const data = loadData()
  const rec = data.codes[c]
  if (!rec) { console.error('卡密不存在'); process.exit(1) }
  if (rec.status !== 'bound') { console.log('该卡密未绑定，无需解绑'); return }
  delete rec.fingerprint
  delete rec.bound_at
  delete rec.license_id
  delete rec.license_json
  rec.status = 'unused'
  saveData(data)
  console.log(`✓ 已解绑 ${maskCode(c)}，可用于新硬盘激活`)
}

function cmdList() {
  const data = loadData()
  const entries = Object.entries(data.codes)
  if (entries.length === 0) { console.log('（暂无卡密）'); return }
  for (const [code, rec] of entries) {
    const bound = rec.status === 'bound'
    console.log(
      `${bound ? '●' : '○'} ${code}  ${rec.plan}  ${rec.days == null ? '永久' : rec.days + '天'}  ${rec.owner}` +
      (bound ? `  已绑定 ${rec.fingerprint} @ ${new Date(rec.bound_at).toLocaleString('zh-CN')}` : '  未使用')
    )
  }
  console.log(`\n共 ${entries.length} 张，已绑定 ${entries.filter(([, r]) => r.status === 'bound').length} 张`)
}

// ── 限速（内存） ────────────────────────────────────────────────────

const ipHits = new Map() // ip → number[] 命中时间戳（毫秒）
const codeFails = new Map() // code → { count, lockedUntil }
const IP_WINDOW = 60_000
const IP_MAX = 10
const CODE_FAIL_LOCK = 10 * 60_000
const CODE_FAIL_MAX = 5

function rateLimitByIp(ip) {
  const now = Date.now()
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < IP_WINDOW)
  hits.push(now)
  ipHits.set(ip, hits)
  if (ipHits.size > 10_000) ipHits.clear() // 粗略防内存膨胀
  return hits.length <= IP_MAX
}

function isCodeLocked(code) {
  const rec = codeFails.get(code)
  return !!rec && rec.lockedUntil > Date.now()
}

function noteCodeFail(code) {
  const rec = codeFails.get(code) || { count: 0, lockedUntil: 0 }
  rec.count++
  if (rec.count >= CODE_FAIL_MAX) {
    rec.lockedUntil = Date.now() + CODE_FAIL_LOCK
    rec.count = 0
  }
  codeFails.set(code, rec)
}

// ── HTTP 服务 ───────────────────────────────────────────────────────

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length })
  res.end(buf)
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > maxBytes) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 卡密激活核心：返回 { status, body } */
async function handleActivate(req, res, ip) {
  if (!rateLimitByIp(ip)) {
    return { status: 429, body: { ok: false, error: '请求过于频繁，请稍后再试' } }
  }

  let raw
  try {
    raw = await readBody(req, 8 * 1024)
  } catch {
    return { status: 413, body: { ok: false, error: '请求体过大' } }
  }
  let body
  try {
    body = JSON.parse(raw)
  } catch {
    return { status: 400, body: { ok: false, error: '请求格式错误' } }
  }

  const code = String(body?.code ?? '').trim().toUpperCase()
  const fingerprint = String(body?.fingerprint ?? '').trim().toLowerCase()
  if (!CODE_RE.test(code)) {
    noteCodeFail(code || '(empty)')
    return { status: 400, body: { ok: false, error: '卡密格式无效' } }
  }
  if (!FP_RE.test(fingerprint)) {
    return { status: 400, body: { ok: false, error: '硬盘指纹无效，请升级客户端后重试' } }
  }
  if (isCodeLocked(code)) {
    return { status: 429, body: { ok: false, error: '该卡密失败次数过多，已临时锁定，请稍后再试' } }
  }

  const data = loadData()
  const rec = data.codes[code]
  if (!rec) {
    noteCodeFail(code)
    console.log(`[activate] ${ip} 卡密不存在 ${maskCode(code)}`)
    return { status: 404, body: { ok: false, error: '卡密不存在，请核对后重试' } }
  }

  // 已绑定：同盘幂等重发原文（不重签——license_id/issued_at 必须保持不变）
  if (rec.status === 'bound') {
    if (rec.fingerprint === fingerprint && rec.license_json) {
      console.log(`[activate] ${ip} 幂等重发 ${maskCode(code)}`)
      return { status: 200, body: { ok: true, license: rec.license_json } }
    }
    console.log(`[activate] ${ip} 已绑他盘 ${maskCode(code)}`)
    return { status: 403, body: { ok: false, error: '该卡密已绑定其他硬盘，如需换绑请联系卖家' } }
  }

  // 未使用：绑定到当前指纹并签发 license
  let issued
  try {
    issued = ISSUE.issueLicense({
      owner: rec.owner,
      plan: rec.plan,
      days: rec.days ?? undefined,
      diskFingerprint: fingerprint
    })
  } catch (e) {
    console.error(`[activate] 签发失败 ${maskCode(code)}: ${e.message}`)
    return { status: 500, body: { ok: false, error: '服务器签发失败，请联系卖家' } }
  }

  rec.status = 'bound'
  rec.fingerprint = fingerprint
  rec.bound_at = Date.now()
  rec.license_id = issued.licenseId
  rec.license_json = issued.licenseJson
  await saveData(data)

  console.log(`[activate] ${ip} 激活成功 ${maskCode(code)} → ${fingerprint}`)
  return { status: 200, body: { ok: true, license: issued.licenseJson } }
}

function startServer() {
  if (!fs.existsSync(path.join(ROOT, 'build', 'license-private.pem'))) {
    console.error('✗ 缺少私钥 build/license-private.pem（先运行 node scripts/generate-license-key.js，或将发行侧私钥复制到服务器）')
    process.exit(1)
  }

  const server = http.createServer(async (req, res) => {
    const ip = (req.socket.remoteAddress || 'unknown').replace('::ffff:', '')
    try {
      if (req.method === 'POST' && req.url === '/v1/activate') {
        const { status, body } = await handleActivate(req, res, ip)
        json(res, status, body)
        return
      }
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      console.error(`[http] ${ip} ${req.url}:`, e.message)
      try { json(res, 500, { ok: false, error: '服务器内部错误' }) } catch { /* 已响应 */ }
    }
  })

  server.listen(PORT, HOST, () => {
    console.log(`✓ 激活服务器已启动: http://${HOST}:${PORT}`)
    console.log('  接口: POST /v1/activate  {code, fingerprint}')
    console.log(`  台账: ${DATA_FILE}`)
  })
}

// ── CLI 入口 ────────────────────────────────────────────────────────

const [cmd, ...args] = process.argv.slice(2)
switch (cmd || 'serve') {
  case 'serve':
    startServer()
    break
  case 'generate':
    cmdGenerate(args[0], args[1], args[2], args[3])
    break
  case 'unbind':
    cmdUnbind(args[0])
    break
  case 'list':
    cmdList()
    break
  default:
    console.error('用法: node server.js [serve | generate <owner> <plan> <days|perpetual> [count] | unbind <code> | list]')
    process.exit(1)
}
