#!/usr/bin/env node
// 从已加密的便携版客户端配置里取 Provider，做一次最小真实请求。
//
// 用法（在你自己的终端里运行，主密码只在本机内存中使用）：
//   node scripts/smoke-stored-provider.mjs
//
// 安全口径：
//  - 主密码不写命令行、不写文件、不进日志；输入时不回显
//  - 只打印 Provider 名称/端点/模型，绝不打印 Key
//  - 错误信息里的 Key 统一替换成 ***
import fs from 'node:fs'
import path from 'node:path'
import { createDecipheriv, scryptSync } from 'node:crypto'
import Database from 'better-sqlite3-multiple-ciphers'

const ROOT = path.resolve(import.meta.dirname, '..')
const DB_PATH = path.join(ROOT, 'artifacts', 'data', 'app.db')
const CFG_PATH = path.join(ROOT, 'artifacts', 'data', 'config.json')

function readPassword() {
  if (process.env.POCKETAI_SMOKE_MASTER_PASSWORD) {
    return Promise.resolve(process.env.POCKETAI_SMOKE_MASTER_PASSWORD)
  }
  return new Promise((resolve) => {
    process.stdout.write('主密码: ')
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    let input = ''
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
    }
    const onData = (ch) => {
      if (ch === '\n' || ch === '\r') {
        cleanup()
        process.stdout.write('\n')
        resolve(input)
      } else if (ch === '\u0003') {
        cleanup()
        process.stdout.write('\n')
        process.exit(1)
      } else if (ch === '\u007f' || ch === '\b') {
        input = input.slice(0, -1)
        process.stdout.write('\b \b')
      } else {
        input += ch
        process.stdout.write('*')
      }
    }
    stdin.on('data', onData)
  })
}

function derive(password, salt, params) {
  const N = Number(params?.N) || 32768
  const r = Number(params?.r) || 8
  const p = Number(params?.p) || 1
  return scryptSync(password, salt, 32, {
    N,
    r,
    p,
    maxmem: Math.max(64 * 1024 * 1024, 128 * N * r * p * 2)
  })
}

/** 与 field-encrypt.ts 的 v1:base64(iv12 + ct + tag16) 完全同构 */
function decryptApiKeys(stored, key) {
  if (!stored) return []
  if (!stored.startsWith('v1:')) {
    try {
      const v = JSON.parse(stored)
      return Array.isArray(v) ? v.map(String) : []
    } catch {
      return []
    }
  }
  try {
    const buf = Buffer.from(stored.slice(3), 'base64')
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(buf.length - 16)
    const ct = buf.subarray(12, buf.length - 16)
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(tag)
    const pt = Buffer.concat([d.update(ct), d.final()]).toString('utf8')
    const v = JSON.parse(pt)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim().replace(/\/+$/, '')
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  if (!/\/v\d+$/.test(url)) url += '/v1'
  return url
}

function redact(text, keys) {
  let out = String(text)
  for (const k of keys) if (k) out = out.split(k).join('***')
  return out
}

async function requestOnce(baseUrl, type, model, apiKey) {
  const base = normalizeBaseUrl(baseUrl)
  const isAnthropic = type === 'anthropic'
  const url = isAnthropic ? `${base}/messages` : `${base}/chat/completions`
  const body = isAnthropic
    ? {
        model,
        max_tokens: 32,
        messages: [{ role: 'user', content: '只回复 pong 三个字母。' }]
      }
    : {
        model,
        max_tokens: 32,
        temperature: 0,
        stream: false,
        messages: [{ role: 'user', content: '只回复 pong 三个字母。' }]
      }
  const headers = isAnthropic
    ? { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
    : { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` }

  const started = Date.now()
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    redirect: 'manual',
    signal: AbortSignal.timeout(60_000)
  })
  const text = await res.text()
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`)
  }
  let answer = ''
  try {
    const json = JSON.parse(text)
    answer = isAnthropic
      ? (json.content ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('')
      : (json.choices?.[0]?.message?.content ?? '')
  } catch {
    answer = text
  }
  return { answer: String(answer).trim(), ms: Date.now() - started }
}

async function main() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(CFG_PATH)) {
    throw new Error(`找不到便携版配置：${DB_PATH}`)
  }
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  const salt = Buffer.from(cfg.masterPasswordSalt, 'base64')
  const password = await readPassword()
  const key = derive(password, salt, cfg.kdfParams)

  const db = new Database(DB_PATH)
  try {
    db.pragma('cipher = sqlcipher')
    db.pragma('legacy = 0')
    db.pragma(`key = "x'${key.toString('hex')}'"`)
    const rows = db
      .prepare('SELECT id, name, type, base_url, models, api_key_encrypted FROM providers ORDER BY created_at ASC')
      .all()
    console.log(`[providers] ${rows.length} 条（以下不显示 Key）`)
    for (const r of rows) {
      const keys = decryptApiKeys(r.api_key_encrypted, key)
      console.log(`  - ${r.name} | ${r.type} | ${r.base_url} | keys=${keys.length}`)
    }
    const candidates = rows
      .map((r) => ({ row: r, keys: decryptApiKeys(r.api_key_encrypted, key) }))
      .filter((x) => x.keys.length > 0 && x.row.base_url)
    if (candidates.length === 0) {
      console.log('没有带 Key 的 Provider，无法冒烟。')
      return
    }
    // 优先选名字/模型里带 8b 的，否则第一条有 Key 的
    const pick =
      candidates.find((x) => /8b/i.test(`${x.row.name} ${x.row.models}`)) ?? candidates[0]
    const models = JSON.parse(pick.row.models || '[]')
    const model = models.find((m) => /8b/i.test(m)) ?? models[0] ?? ''
    if (!model) throw new Error(`Provider ${pick.row.name} 没有可用 model`)
    console.log(`[smoke] 使用 ${pick.row.name} · ${pick.row.base_url} · ${model}`)

    let lastError = null
    for (const apiKey of pick.keys) {
      try {
        const out = await requestOnce(pick.row.base_url, pick.row.type, model, apiKey)
        console.log(`[smoke] OK · ${out.ms}ms · 回复=${out.answer.slice(0, 120)}`)
        return
      } catch (e) {
        lastError = e
      }
    }
    throw new Error(`该 Provider 的 ${pick.keys.length} 把 Key 均未成功：${redact(lastError?.message ?? '', pick.keys)}`)
  } finally {
    db.close()
    key.fill(0)
  }
}

main().catch((e) => {
  console.error(`[smoke] 失败：${e instanceof Error ? e.message : String(e)}`)
  process.exitCode = 1
})
