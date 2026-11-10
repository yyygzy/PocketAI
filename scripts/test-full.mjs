#!/usr/bin/env node
/**
 * 全量测试闸门：跑全量 vitest，再把「被 worker 启动超时吞掉」的测试文件补跑回来。
 *
 * 背景（2026-11 排查结论，这里只复述落点）：
 *  · 单个 .test.tsx 冷加载 jsdom 要拉 944 个 CJS 模块，本机安全软件会把它放大到数十秒；
 *    vitest 的 worker 启动超时是源码里写死的 60s，超时文件不进 JSON 的 testResults，
 *    只在 unhandledErrors 里记一笔并让退出码非零 —— 所以「没执行」不能靠错误统计猜。
 *  · 判据只看两份清单的差集：测试文件快照 vs JSON 里实际出现的 testResults 文件。
 *  · isolate:false 实测省 54.6% 墙钟但会串模块缓存与 DOM 残留，不采用；8 worker 只快 3.6%，
 *    瓶颈是每个文件各自的 jsdom 初始化，故全量固定 4 worker。
 *
 * 用法：
 *   npm run test:full                    # 全量 + 差集 + 补跑 + 三类汇总
 *   node scripts/test-full.mjs --keep    # 保留 %TEMP% 下的 JSON，便于逐条看失败详情
 *
 * 退出码（可直接当提交前闸门）：
 *   0 = 全绿（真失败 0，被吞 0；平台跳过不算红）
 *   1 = 有真失败（已执行且断言失败 / 超时红）
 *   2 = 无真失败但仍有文件补跑后未被执行（＝再次被吞，通常是负载太高，重跑即可）
 *   3 = 脚本自身没能拿到可判定的结果（JSON 缺失 / 解析失败）
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '..')
const TESTS_DIR = path.join(ROOT, 'tests')
const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx)$/

// ── 可调常量（别在流程里散落魔法数） ──────────────────────
const FULL_MAX_WORKERS = 4 // 全量并发：8 worker 只快约 3.6%，瓶颈是每文件 jsdom 初始化
const RETRY_POOL = 'threads' // 补跑用 worker_threads，避开 fork 池的启动开销
const RETRY_MAX_WORKERS = 2 // 补跑并发刻意压低：被吞本来就是并发抢机器导致的
const RETRY_BATCH_SIZE = 8 // 每批补跑多少个文件，批越小越不容易再次整批被吞
const RETRY_MAX_ROUNDS = 2 // 同一批最多补跑几轮；仍不出现则判「超时被吞」

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url

// ── 工具 ─────────────────────────────────────────────────
/** 仓库内相对路径统一成 POSIX 风格，用于两份清单做差集 */
function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/')
}

/** 按 vitest include（tests/**\/*.{test,spec}.{ts,tsx}）列出清单快照 */
function snapshotTestFiles(dir = TESTS_DIR) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...snapshotTestFiles(full))
    else if (TEST_FILE_RE.test(name)) out.push(rel(full))
  }
  return out.sort()
}

function runVitest({ files, maxWorkers, pool, jsonFile, label }) {
  const args = [
    'vitest',
    'run',
    '--reporter=dot',
    '--reporter=json',
    `--outputFile.json=${jsonFile}`,
    `--maxWorkers=${maxWorkers}`
  ]
  if (pool) args.push(`--pool=${pool}`)
  if (files) args.push(...files)

  console.log(`\n▶ ${label}：${files ? files.length : '全部'} 个文件 · maxWorkers=${maxWorkers}${pool ? ` · pool=${pool}` : ''}`)
  const started = Date.now()
  const r = spawnSync('npx', args, { cwd: ROOT, stdio: 'inherit', shell: true })
  const seconds = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`◀ ${label}结束：exit=${r.status ?? 'null'} · ${seconds}s`)
  return r.status
}

/**
 * 读 vitest JSON reporter 的产物，返回「文件 → 结果」。
 * 只认 testResults 里真的出现过的文件——这就是「实际执行清单」。
 */
function readJsonReport(jsonFile) {
  if (!existsSync(jsonFile)) return null
  let data
  try {
    data = JSON.parse(readFileSync(jsonFile, 'utf8'))
  } catch {
    return null
  }
  const files = new Map()
  for (const tr of data.testResults || []) {
    const assertions = tr.assertionResults || []
    const failed = assertions.filter((a) => a.status === 'failed')
    const passed = assertions.filter((a) => a.status === 'passed')
    const skipped = assertions.filter((a) => a.status === 'skipped' || a.status === 'pending' || a.status === 'todo')
    const name = rel(String(tr.name || ''))
    files.set(name, {
      fileStatus: tr.status,
      failed,
      passed,
      skipped,
      // 文件级失败（收集/teardown 报错）也要算真失败，不能只看断言
      failedFile: tr.status === 'failed' && failed.length === 0,
      message: String(tr.message || '')
    })
  }
  return { files, unhandledErrors: data.unhandledErrors || [], success: data.success }
}

function classify(entry) {
  if (!entry) return 'missing'
  if (entry.fileStatus === 'failed' || entry.failed.length > 0) return 'failed'
  if (entry.passed.length === 0 && entry.skipped.length > 0) return 'skipped'
  return 'passed'
}

function failDetail(entry) {
  if (!entry) return ''
  const names = entry.failed.map((a) => a.title || a.fullName || a.ancestorTitles?.join(' > ') || '未命名用例')
  if (names.length > 0) return `${names.length} 条失败：${names.slice(0, 3).join(' / ')}${names.length > 3 ? ' …' : ''}`
  if (entry.failedFile) return `文件级失败${entry.message ? `：${entry.message.split('\n')[0].slice(0, 160)}` : ''}`
  return ''
}

function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

// ── 主流程 ───────────────────────────────────────────────
function main() {
  const keep = process.argv.includes('--keep')
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'pocketai-test-full-'))
  const fullJson = path.join(tmpDir, 'full.json')
  console.log(`临时产物目录：${tmpDir}${keep ? '（--keep）' : ''}`)

  const snapshot = snapshotTestFiles()
  console.log(`清单快照：${snapshot.length} 个测试文件（tests/**/*.{test,spec}.{ts,tsx}）`)

  // ① 全量（不跑已通过的单文件，先拿到「实际执行清单」）
  runVitest({ maxWorkers: FULL_MAX_WORKERS, jsonFile: fullJson, label: '全量 vitest' })
  const full = readJsonReport(fullJson)
  if (!full) {
    console.error('✗ 全量 JSON 报告缺失或无法解析，无法用差集判定被吞文件')
    if (!keep) rmSync(tmpDir, { recursive: true, force: true })
    process.exit(3)
  }

  const executed = new Set(full.files.keys())
  const swallowed = snapshot.filter((f) => !executed.has(f))

  // ② 补跑：只跑差集里的文件，分批 + 低并发 + threads 池
  const failed = new Map()
  const skipped = []
  let passedCount = 0
  for (const [file, entry] of full.files) {
    const kind = classify(entry)
    if (kind === 'failed') failed.set(file, failDetail(entry))
    else if (kind === 'skipped') skipped.push(file)
    else if (kind === 'passed') passedCount++
  }

  console.log(`\n全量实际执行：${full.files.size} 个 · 通过 ${passedCount} · 失败 ${failed.size} · 跳过 ${skipped.length}`)
  console.log(`差集判定被吞：${swallowed.length} 个${swallowed.length > 0 ? ' → 只补跑这一批' : '（无需补跑）'}`)

  let pending = swallowed.slice()
  let restored = 0
  for (let round = 1; round <= RETRY_MAX_ROUNDS && pending.length > 0; round++) {
    console.log(`\n—— 补跑第 ${round}/${RETRY_MAX_ROUNDS} 轮：${pending.length} 个文件 ——`)
    const stillMissing = []
    for (const [i, batch] of chunk(pending, RETRY_BATCH_SIZE).entries()) {
      const jsonFile = path.join(tmpDir, `retry-r${round}-b${i + 1}.json`)
      runVitest({
        files: batch,
        maxWorkers: RETRY_MAX_WORKERS,
        pool: RETRY_POOL,
        jsonFile,
        label: `补跑 r${round} 批 ${i + 1}/${Math.ceil(pending.length / RETRY_BATCH_SIZE)}`
      })
      const report = readJsonReport(jsonFile)
      if (!report) {
        // 连报告都没有：这一批全部当作本轮仍未执行，留给下一轮
        stillMissing.push(...batch)
        continue
      }
      for (const file of batch) {
        const entry = report.files.get(file)
        if (!entry) {
          stillMissing.push(file)
          continue
        }
        restored++
        const kind = classify(entry)
        if (kind === 'failed') failed.set(file, failDetail(entry))
        else if (kind === 'skipped') skipped.push(file)
        else passedCount++
      }
    }
    pending = stillMissing
  }

  // ③ 三类结果 + 退出码
  const lines = []
  lines.push('')
  lines.push('========== 全量测试补跑报告 ==========')
  lines.push(`  清单快照 ${snapshot.length} · 全量执行 ${full.files.size} · 被吞 ${swallowed.length} · 补跑恢复 ${restored}`)
  lines.push(`  通过 ${passedCount} · 平台跳过 ${skipped.length} · 真失败 ${failed.size} · 补跑后仍被吞 ${pending.length}`)

  if (failed.size > 0) {
    lines.push('')
    lines.push('── 真失败（需要修）')
    for (const [file, detail] of failed) lines.push(`  ✗ ${file}${detail ? `\n    · ${detail}` : ''}`)
  }
  if (pending.length > 0) {
    lines.push('')
    lines.push(`── 超时被吞（补跑 ${RETRY_MAX_ROUNDS} 轮仍未进 testResults，提高机器空闲度后重跑）`)
    for (const file of pending) lines.push(`  ! ${file}`)
  }
  if (skipped.length > 0) {
    lines.push('')
    lines.push('── 平台跳过（整文件无断言执行，不阻塞提交）')
    for (const file of skipped) lines.push(`  - ${file}`)
  }
  if (full.unhandledErrors.length > 0) {
    lines.push('')
    lines.push(`  （全量运行另有 ${full.unhandledErrors.length} 条 unhandled error，已用差集口径过滤，不计入三类）`)
  }

  lines.push('')
  let code = 0
  if (failed.size > 0) {
    code = 1
    lines.push('  ✗ 存在真失败，不能提交')
  } else if (pending.length > 0) {
    code = 2
    lines.push('  ! 无真失败，但仍有文件未被执行；这通常是并发抢机器，空闲时重跑')
  } else {
    lines.push('  ✓ 全绿，可以提交')
  }
  lines.push('======================================')
  console.log(lines.join('\n'))

  if (!keep) rmSync(tmpDir, { recursive: true, force: true })
  else console.log(`\n保留临时产物：${tmpDir}`)
  process.exit(code)
}

if (isMain) main()
