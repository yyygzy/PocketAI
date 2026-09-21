#!/usr/bin/env node
// License 签发台（交互式，仅发行侧使用）
// 运行: npm run license   或   node scripts/license-studio.js
//
// 功能：
//   1. 单个签发 —— 逐项问答 + 默认值 + 预览确认，签完自动存文件/记账/可复制到剪贴板
//   2. 批量签发 —— 从 CSV 一次签一批（每行: 授权对象,plan,期限）
//   3. 历史台账 —— 查看 licenses/issued-log.jsonl 签发记录
//
// 期限写法（批量 CSV 第三列 / 单发的自定义天数）：
//   3650 = 天数   2027-12-31 = 到期日   perpetual / 0 = 永久买断
const readline = require('node:readline/promises')
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')
const { issueLicense, PLANS, DEFAULT_FEATURES, describeExpiry } = require('./lib/issue-license')

const ROOT = path.join(__dirname, '..')
const KEY_PATH = path.join(ROOT, 'build', 'license-private.pem')
const OUT_DIR = path.join(ROOT, 'licenses')
const LEDGER = path.join(OUT_DIR, 'issued-log.jsonl')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY })

// 非交互模式（stdin 为管道/文件重定向）：预读全部输入逐行消费。
// 原因：readline 对普通文件流一次读完即触发 close，第二个 question 会永久挂起。
let canned = null
let cannedIdx = 0
if (!process.stdin.isTTY) {
  try {
    canned = fs.readFileSync(0, 'utf8').split(/\r?\n/).map((s) => s.trim())
  } catch {
    canned = []
  }
}

const ask = async (q, def) => {
  let a = ''
  if (canned) {
    process.stdout.write(q)
    a = cannedIdx < canned.length ? canned[cannedIdx++] : ''
    if (a) process.stdout.write(a + '\n')
  } else {
    a = (await rl.question(q)).trim()
  }
  return a || (def ?? '')
}
const askUntil = async (q, validate, errMsg, def) => {
  for (;;) {
    const a = await ask(q, def)
    const v = validate(a)
    if (v.ok) return v.value
    console.log('  ✗ ' + (errMsg || '输入无效，请重试'))
  }
}

function ensureKey() {
  if (!fs.existsSync(KEY_PATH)) {
    console.error('✗ 缺少私钥 build/license-private.pem')
    console.error('  先运行: node scripts/generate-license-key.js')
    console.error('  生成后把输出中的公钥填入 src/main/license/public-key.ts 并重新打包')
    process.exit(1)
  }
}

/** 授权对象 → 安全文件名 */
const safeName = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'unnamed'
const todayTag = () => new Date().toISOString().slice(0, 10).replace(/-/g, '')

function appendLedger(entry) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.appendFileSync(LEDGER, JSON.stringify(entry) + '\n', 'utf8')
}

/** 复制文本到剪贴板（best effort，失败不阻塞签发流程） */
function clipboardCopy(text) {
  try {
    if (process.platform === 'win32') {
      // 走 stdin 管道，避免命令行长度与转义问题
      execSync('powershell -NoProfile -Command "$input | Set-Clipboard"', { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      return true
    }
    if (process.platform === 'darwin') {
      execSync('pbcopy', { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
      return true
    }
    execSync('xclip -selection clipboard', { input: text, stdio: ['pipe', 'ignore', 'ignore'] })
    return true
  } catch {
    return false
  }
}

/** 解析期限输入: 天数 / YYYY-MM-DD / perpetual|0 */
function parseTerm(input) {
  const s = String(input).trim().toLowerCase()
  if (!s || s === 'perpetual' || s === '0' || s === '永久') return { perpetual: true }
  if (/^\d+$/.test(s)) return { days: Number(s) }
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  if (m) {
    const t = new Date(`${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}T23:59:59+08:00`).getTime()
    if (!Number.isNaN(t) && t > Date.now()) return { expiresAt: t }
  }
  return null
}

// ── 单个签发 ──────────────────────────────────────────────
async function issueOne() {
  const owner = await askUntil(
    '授权给（姓名/组织）: ',
    (a) => (a && a.length <= 60 ? { ok: true, value: a } : { ok: false }),
    '不能为空，长度 ≤ 60'
  )

  console.log('\n版本类型:')
  console.log('  1) pro         个人专业版（默认）')
  console.log('  2) enterprise  企业版')
  console.log('  3) free        免费码（不解除数量限制，仅用于定向解锁功能/限时试用，一般不用签）')
  const plan = await askUntil(
    '选择 [1-3，回车=1]: ',
    (a) => {
      if (a === '' || a === '1') return { ok: true, value: 'pro' }
      if (a === '2') return { ok: true, value: 'enterprise' }
      if (a === '3') return { ok: true, value: 'free' }
      return { ok: false }
    },
    '请输入 1 / 2 / 3'
  )
  if (plan === 'free') {
    console.log('  ℹ 提示: 用户不激活就是免费版，free 码仅在「送单个功能」或「限时试用」活动时才需要。')
  }

  console.log('\n有效期:')
  console.log('  1) 1 年      2) 3 年      3) 10 年（默认）')
  console.log('  4) 永久买断  5) 自定义天数  6) 自定义到期日(YYYY-MM-DD)')
  const term = await askUntil(
    '选择 [1-6，回车=3]: ',
    (a) => {
      switch (a) {
        case '': case '3': return { ok: true, value: { days: 3650 } }
        case '1': return { ok: true, value: { days: 365 } }
        case '2': return { ok: true, value: { days: 1095 } }
        case '4': return { ok: true, value: { perpetual: true } }
        case '5': case '6': return { ok: true, value: { custom: a } }
        default: return { ok: false }
      }
    },
    '请输入 1-6'
  )
  let termSpec = term
  if (term && term.custom) {
    const hint = term.custom === '5' ? '天数（如 180）: ' : '到期日 YYYY-MM-DD（如 2027-12-31）: '
    termSpec = await askUntil(hint, (a) => {
      const p = parseTerm(a)
      return p ? { ok: true, value: p } : { ok: false }
    }, '格式不对：天数 / YYYY-MM-DD / perpetual')
  }

  const features = await ask(`功能列表（回车=全量: ${DEFAULT_FEATURES}）\n: `, DEFAULT_FEATURES)

  // 硬盘指纹（可选绑定）：用户在应用「设置 → 授权激活」页可查看本机指纹（16 位 hex）
  const fingerprint = (await ask('\n硬盘指纹（回车=不绑定设备；绑定后仅该硬盘可激活）\n: ', '')).trim()
  if (fingerprint && !/^[0-9a-fA-F]{16}$/.test(fingerprint)) {
    console.log('  ✗ 指纹格式无效（应为 16 位 hex），本次签发中止')
    return
  }

  // 预览
  let preview
  try {
    preview = issueLicense({ owner, plan, ...cleanTerm(termSpec), features: features.split(',').map((s) => s.trim()).filter(Boolean), diskFingerprint: fingerprint })
  } catch (e) {
    console.error('✗ ' + e.message)
    return
  }
  console.log('\n──── 即将签发 ────')
  console.log(`  授权给   ${owner}`)
  console.log(`  版本     ${plan}`)
  console.log(`  有效期   ${describeExpiry(preview.expiresAt)}`)
  console.log(`  功能     ${preview.payload.features.join(', ')}`)
  if (preview.payload.disk_fingerprint) {
    console.log(`  设备绑定 ${preview.payload.disk_fingerprint}`)
  }
  const ok = await askUntil('确认签发? [Y/n]: ', (a) => {
    const v = (a || 'y').toLowerCase()
    return v === 'y' || v === 'n' ? { ok: true, value: v === 'y' } : { ok: false }
  }, '请输入 Y 或 n')
  if (!ok) {
    console.log('已取消（未生成任何文件）')
    return
  }

  // 重新签发确认版（license_id 换新，避免「取消了又复用预览」）
  const r = issueLicense({ owner, plan, ...cleanTerm(termSpec), features: features.split(',').map((s) => s.trim()).filter(Boolean), diskFingerprint: fingerprint })
  const file = path.join(OUT_DIR, `${safeName(owner)}-${plan}-${todayTag()}.lic`)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(file, r.licenseJson, 'utf8')
  appendLedger({
    issued_at: Date.now(),
    license_id: r.licenseId,
    owner: r.payload.owner,
    plan: r.payload.plan,
    expires_at: r.expiresAt,
    features: r.payload.features,
    file: path.basename(file)
  })

  console.log('\n✓ 已签发')
  console.log(`  文件   ${file}`)
  console.log(`  编号   ${r.licenseId}`)
  console.log(`  有效期 ${describeExpiry(r.expiresAt)}`)
  if (await askBool('复制激活内容到剪贴板? [y/N]: ', false)) {
    console.log(clipboardCopy(r.licenseJson) ? '✓ 已复制，可直接粘贴发给用户' : '（剪贴板不可用，请直接打开 .lic 文件复制）')
  }
  console.log('\n用户激活方式: 设置 → 授权激活 → 导入该 .lic 文件，或点「粘贴激活码」粘贴 JSON 内容')
}

function cleanTerm(t) {
  if (!t) return {}
  if (t.perpetual) return {}
  if (t.days) return { days: t.days }
  if (t.expiresAt) return { expiresAt: t.expiresAt }
  return {}
}

async function askBool(q, def) {
  const a = (await ask(q, def ? 'y' : 'n')).toLowerCase()
  if (!a) return def
  return a === 'y' || a === 'yes'
}

// ── 批量签发 ──────────────────────────────────────────────
async function issueBatch() {
  const csvPath = path.resolve(await ask(`CSV 文件路径（回车=licenses/batch.csv）: `, 'licenses/batch.csv'))
  if (!fs.existsSync(csvPath)) {
    console.error(`✗ 找不到 ${csvPath}`)
    console.error('  CSV 格式（每行一条，# 开头为注释）:')
    console.error('    授权对象,plan,期限')
    console.error('    张三,pro,3650')
    console.error('    李四,pro,perpetual')
    console.error('    XX公司,enterprise,2027-12-31')
    return
  }
  const rows = fs.readFileSync(csvPath, 'utf8')
    .split(/\r?\n/)
    .map((l, i) => ({ line: l.trim(), no: i + 1 }))
    .filter((x) => x.line && !x.line.startsWith('#'))
  if (rows.length === 0) {
    console.error('✗ CSV 没有有效行')
    return
  }
  console.log(`共 ${rows.length} 条待签发\n`)
  let okCount = 0
  const failed = []
  for (const { line, no } of rows) {
    const [owner, plan, term] = line.split(',').map((s) => (s || '').trim())
    try {
      if (!owner) throw new Error('owner 为空')
      if (!PLANS.includes(plan)) throw new Error(`plan 无效: ${plan || '(空)'}`)
      const p = term ? parseTerm(term) : { perpetual: true }
      if (!p) throw new Error(`期限格式无效: ${term}（应为天数/YYYY-MM-DD/perpetual）`)
      const r = issueLicense({ owner, plan, ...cleanTerm(p) })
      const file = path.join(OUT_DIR, `${safeName(owner)}-${plan}-${todayTag()}.lic`)
      fs.mkdirSync(OUT_DIR, { recursive: true })
      fs.writeFileSync(file, r.licenseJson, 'utf8')
      appendLedger({
        issued_at: Date.now(),
        license_id: r.licenseId,
        owner: r.payload.owner,
        plan: r.payload.plan,
        expires_at: r.expiresAt,
        features: r.payload.features,
        file: path.basename(file)
      })
      okCount++
      console.log(`  ✓ 行${no}  ${owner}  ${plan}  ${describeExpiry(r.expiresAt)}  → ${path.basename(file)}`)
    } catch (e) {
      failed.push({ no, line, reason: e.message })
      console.log(`  ✗ 行${no}  ${line}  ← ${e.message}`)
    }
  }
  console.log(`\n完成: 成功 ${okCount}，失败 ${failed.length}${failed.length ? '（已跳过，可修正 CSV 后重跑）' : ''}`)
  if (okCount > 0) console.log(`台账与 .lic 文件均在 licenses/ 目录`)
}

// ── 台账 ──────────────────────────────────────────────────
function showLedger() {
  if (!fs.existsSync(LEDGER)) {
    console.log('还没有签发记录（licenses/issued-log.jsonl 不存在）')
    return
  }
  const rows = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter(Boolean)
  if (rows.length === 0) {
    console.log('台账为空')
    return
  }
  console.log(`共 ${rows.length} 条签发记录（最近 30 条）\n`)
  const recent = rows.slice(-30).reverse()
  for (const r of recent) {
    const d = new Date(r.issued_at).toLocaleString('zh-CN', { hour12: false })
    const exp = describeExpiry(r.expires_at)
    console.log(`  ${d}  ${r.license_id}  ${r.owner}  ${r.plan}  ${exp}`)
  }
  const byPlan = {}
  for (const r of rows) byPlan[r.plan] = (byPlan[r.plan] || 0) + 1
  console.log('\n按版本统计: ' + Object.entries(byPlan).map(([k, v]) => `${k}×${v}`).join('  '))
}

// ── 主循环 ────────────────────────────────────────────────
async function main() {
  ensureKey()
  console.log('═══════════════════════════════════════')
  console.log('  墨匣激活码签发台（离线 RSA 签发）')
  console.log('═══════════════════════════════════════')
  for (;;) {
    console.log('\n  1) 签发单个激活码')
    console.log('  2) 批量签发（CSV）')
    console.log('  3) 查看历史台账')
    console.log('  0) 退出')
    const c = await ask('选择 [0-3]: ', '')
    if (c === '1') await issueOne()
    else if (c === '2') await issueBatch()
    else if (c === '3') showLedger()
    else if (c === '0' || c === 'q' || c === 'exit') break
    else console.log('无效选择')
  }
  rl.close()
  console.log('再见')
}

main().catch((e) => {
  console.error('发生错误: ' + (e?.message || e))
  process.exit(1)
})
