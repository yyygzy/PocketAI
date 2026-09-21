#!/usr/bin/env node
/**
 * 墨匣发布前检查脚本
 *
 * 用法：
 *   node scripts/release-check.mjs           # 全量检查（含 tsc + electron-vite build）
 *   node scripts/release-check.mjs --quick   # 跳过编译验证
 *
 * 输出分级：PASS 通过 / FAIL 失败(阻塞发布) / WARN 警告(需判断) / SKIP 不适用 / MANUAL 需人工
 * 退出码：存在 FAIL 时为 1，否则 0
 */
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs'
import { createPublicKey, verify as cryptoVerify } from 'node:crypto'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const quick = process.argv.includes('--quick')

// ── 结果收集 ─────────────────────────────────────────────
let pass = 0, fail = 0, warn = 0, skip = 0, manual = 0
let currentGroup = ''
const rows = []

function group(title) {
  currentGroup = title
  rows.push({ type: 'group', title })
}
function result(status, name, detail = '') {
  if (status === 'PASS') pass++
  else if (status === 'FAIL') fail++
  else if (status === 'WARN') warn++
  else if (status === 'SKIP') skip++
  rows.push({ type: 'item', status, name, detail })
}
function manualItem(name, detail = '') {
  manual++
  rows.push({ type: 'item', status: 'MANUAL', name, detail })
}

// ── 工具 ─────────────────────────────────────────────────
function git(args) {
  try { return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim() } catch { return '' }
}
function sh(cmd, label) {
  try { execSync(cmd, { cwd: ROOT, stdio: 'pipe', shell: true }); return { ok: true } } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-5).join(' | ')
    return { ok: false, error: tail.slice(0, 300) }
  }
}
function readText(p) { try { return readFileSync(join(ROOT, p), 'utf8') } catch { return null } }
function yamlGet(text, key) {
  const m = text.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null
}
function distFiles(pattern) {
  const dir = join(ROOT, 'dist')
  if (!existsSync(dir)) return []
  const re = new RegExp(pattern)
  return readdirSync(dir).filter((f) => re.test(f) && statSync(join(dir, f)).isFile())
}

// ── A. 版本与仓库一致性 ──────────────────────────────────
group('A. 版本与仓库一致性')
const pkg = JSON.parse(readText('package.json') || '{}')
const version = pkg.version || ''
result(/^\d+\.\d+\.\d+/.test(version) ? 'PASS' : 'FAIL', 'package.json version 格式', `当前 ${version || '缺失'}`)
if (/^0\./.test(version)) result('WARN', '正式发布前需升到 1.0.0', `当前 ${version}，tag 将为 v${version}，升级后再发布才能命中 v1.0.0`)
else result('PASS', '版本号已达正式版', version)

const pkgPub = pkg.build?.publish || {}
const linuxPub = (() => { const t = readText('electron-builder.linux.yml'); return t ? { owner: yamlGet(t, 'owner'), repo: yamlGet(t, 'repo') } : {} })()
const wf = readText('.github/workflows/release.yml') || ''
result(
  pkgPub.owner === 'yyygzy' && pkgPub.repo === 'PocketAI' && linuxPub.owner === 'yyygzy' && linuxPub.repo === 'PocketAI'
    ? 'PASS' : 'FAIL',
  'publish owner/repo 一致（package.json + linux.yml）',
  `package.json: ${pkgPub.owner}/${pkgPub.repo} · linux.yml: ${linuxPub.owner}/${linuxPub.repo}`
)
// workflow 仓库地址由 GITHUB_REPOSITORY 自动注入（softprops 默认行为），无需写死；检查 asar-patcher 写死的增量补丁源
const ap = readText('src/main/update/asar-patcher.ts') || ''
result(
  ap.includes("GITHUB_OWNER = 'yyygzy'") && ap.includes("GITHUB_REPO = 'PocketAI'")
    ? 'PASS' : 'FAIL',
  'asar-patcher.ts 增量补丁源与 publish 一致',
  ap.includes("GITHUB_OWNER = 'yyygzy'") ? '' : '未找到 GITHUB_OWNER/GITHUB_REPO'
)

// ── B. 构建配置完整性 ────────────────────────────────────
group('B. 构建配置完整性')
const build = pkg.build || {}
const winTargets = (build.win?.target || []).map((t) => t.target || t)
result(winTargets.includes('nsis') && winTargets.includes('portable') ? 'PASS' : 'FAIL', 'Windows 双包 target（nsis + portable）', winTargets.join(', '))
result(build.portable?.artifactName === 'Moxia-${version}-Portable-${arch}.${ext}' ? 'PASS' : 'WARN', '便携版 artifactName', build.portable?.artifactName || '未配置')

const lx = readText('electron-builder.linux.yml') || ''
result(lx.includes('AppImage') ? 'PASS' : 'FAIL', 'Linux AppImage target', '')
result(lx.includes('{darwin,win32}-*.node') ? 'PASS' : 'FAIL', '跨平台 prebuilds 排除规则（排除 darwin/win32）', '')
result(lx.includes('artifactName: Moxia-${version}-Linux-${arch}.${ext}') ? 'PASS' : 'WARN', 'Linux artifactName', '')
result(pkg.scripts?.['dist'] && pkg.scripts?.['dist:linux'] ? 'PASS' : 'FAIL', 'dist / dist:linux 脚本存在', '')

result(wf.includes('build-linux') ? 'PASS' : 'FAIL', 'CI 有 build-linux job', '')
result(wf.includes("startsWith(github.ref, 'refs/tags/v')") ? 'PASS' : 'FAIL', 'Release 步骤仅 tag 推送时执行', '')
// CI 上传 glob 要么显式列 *.blockmap/*.AppImage/*.yml，要么用 dist/all/* 全目录（flatten 上传所有产物）
const globAll = wf.includes('dist/all/*') || wf.includes('dist/**/*')
const explicitGlobs = wf.includes('*.blockmap') && wf.includes('*.AppImage') && wf.includes('*.yml')
result((globAll || explicitGlobs) ? 'PASS' : 'FAIL', 'CI 上传/发布 glob 含 blockmap + yml + AppImage', globAll ? '全目录上传 dist/all/*' : explicitGlobs ? '显式 glob' : '')
result(wf.includes('npm run dist:linux') ? 'PASS' : 'FAIL', 'CI Linux job 调用 dist:linux', '')

// ── C. 构建产物（存在才验） ──────────────────────────────
group('C. 构建产物检查（本地 dist/）')
const hasDist = existsSync(join(ROOT, 'dist'))
const setups = distFiles(/^Moxia-\d+\.\d+\.\d+-x64\.exe$/)
const portables = distFiles(/^Moxia-\d+\.\d+\.\d+-Portable-x64\.exe$/)
const appimages = distFiles(/^Moxia-\d+\.\d+\.\d+-Linux-x64\.AppImage$/i)
const latestYml = readText('dist/latest.yml')
const latestLinuxYml = readText('dist/latest-linux.yml')
const blockmaps = distFiles(/\.blockmap$/)

if (!hasDist) {
  result('SKIP', '本地无 dist/ 目录', 'CI 构建模式：产物在 GitHub Actions artifact 中，发布时自动附到 Release')
} else {
  result(setups.length ? 'PASS' : 'WARN', 'NSIS 安装包', setups.join(', ') || '未找到（如需本地产物跑 npm run dist）')
  result(portables.length ? 'PASS' : 'WARN', 'Windows 便携版', portables.join(', ') || '未找到')
  result(appimages.length ? 'PASS' : 'WARN', 'Linux AppImage', appimages.join(', ') || '未找到（AppImage 由 CI 构建属正常）')

  for (const [label, yml] of [['Windows 更新清单 latest.yml', latestYml], ['Linux 更新清单 latest-linux.yml', latestLinuxYml]]) {
    if (!yml) { result('WARN', label, '未找到'); continue }
    const v = yamlGet(yml, 'version')
    const p = yamlGet(yml, 'path')
    const sha = yamlGet(yml, 'sha512')
    if (v !== version) result('FAIL', `${label} 版本一致`, `yml=${v} package.json=${version}`)
    else if (!sha) result('FAIL', `${label} 缺 sha512`, '')
    else if (!p) result('FAIL', `${label} 缺 path`, '')
    else result('PASS', label, `version=${v} path=${p}`)
  }

  // AppImage 魔数（offset 8 = "AI"）
  if (appimages.length) {
    const f = join(ROOT, 'dist', appimages[0])
    const head = readFileSync(f).subarray(0, 12)
    const magic = head.toString('ascii', 8, 10)
    result(magic === 'AI' ? 'PASS' : 'FAIL', 'AppImage 魔数（offset 8 = AI）', `实际 ${magic === 'AI' ? 'AI' : head.toString('hex')}`)
    result(blockmaps.some((b) => b.includes('AppImage')) ? 'PASS' : 'WARN', 'AppImage blockmap（增量更新）', blockmaps.filter((b) => b.includes('AppImage')).join(', ') || '未找到')
  }
  result(blockmaps.some((b) => !b.includes('AppImage')) ? 'PASS' : 'WARN', 'NSIS blockmap（增量更新）', blockmaps.filter((b) => !b.includes('AppImage')).join(', ') || '未找到')

  // 产物文件名版本一致性
  const allArtifacts = [...setups, ...portables, ...appimages]
  const mismatch = allArtifacts.filter((f) => !f.includes(version))
  result(mismatch.length === 0 ? 'PASS' : 'FAIL', '产物文件名版本一致', mismatch.length ? mismatch.join(', ') : allArtifacts.join(', '))
}

// ── D. 加密与凭据安全 ────────────────────────────────────
group('D. 加密与凭据安全')
const keyPath = join(ROOT, 'build/license-private.pem')
result(existsSync(keyPath) ? 'PASS' : 'FAIL', '签发私钥存在（build/license-private.pem）', existsSync(keyPath) ? '' : '签发台不可用，跑 scripts/generate-license-key.js 重新生成')

const tracked = git('ls-files build/license-private.pem')
result(tracked === '' ? 'PASS' : 'FAIL', '私钥未被 git 追踪', tracked || '')
const leaked = git('log --all --oneline -- build/license-private.pem')
result(leaked === '' ? 'PASS' : 'FAIL', '私钥从未进入提交历史', leaked ? '发现历史记录！必须立即换钥（generate-license-key.js + 更新 public-key.ts）' : '')
result(git('check-ignore licenses') !== '' ? 'PASS' : 'WARN', 'licenses/ 签发台账已 gitignore', git('check-ignore licenses') ? '' : '签发产物含用户姓名，建议加入 .gitignore')

// 签发 → 验签闭环（与应用主进程同算法：RSA-SHA256 over canonical payload）
try {
  const { issueLicense, canonicalize } = await import('./lib/issue-license.js')
  const tmp = mkdtempSync(join(tmpdir(), 'pocketai-rc-'))
  const { licenseJson, payload } = issueLicense({ owner: '发布检查', plan: 'pro', days: 1, keyPath })
  writeFileSync(join(tmp, 'test.lic'), licenseJson, 'utf8')
  const pub = readText('src/main/license/public-key.ts') || ''
  const b64 = pub.match(/PUBLIC_KEY_DER_B64\s*=\s*'([^']+)'/)?.[1]
  if (!b64) { result('FAIL', '公钥提取', 'public-key.ts 中未找到 PUBLIC_KEY_DER_B64') }
  else {
    const keyObj = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' })
    // licenseJson = { ...payload, signature }；验签对象是不含 signature 的规范化字符串
    const { signature } = JSON.parse(licenseJson)
    const ok = cryptoVerify('sha256', Buffer.from(canonicalize(payload), 'utf8'), keyObj, Buffer.from(signature, 'base64'))
    result(ok ? 'PASS' : 'FAIL', '激活码签发 → 内置公钥验签闭环', ok ? '签名与主进程验签算法匹配' : '验签失败！签发与应用算法不一致')
  }
  rmSync(tmp, { recursive: true, force: true })
} catch (e) {
  result('FAIL', '激活码签发 → 内置公钥验签闭环', String(e.message || e).slice(0, 200))
}

// ── E. 仓库卫生 ──────────────────────────────────────────
group('E. 仓库卫生')
const dirty = git('status --porcelain')
result(dirty === '' ? 'PASS' : 'FAIL', '工作树干净（发布前必须全部提交）', dirty ? dirty.split('\n').slice(0, 5).join(' | ') : '')
result(git('branch --show-current') === 'main' ? 'PASS' : 'WARN', '当前分支为 main', git('branch --show-current'))
const ab = git('rev-list --left-right --count origin/main...HEAD')
const [behind, ahead] = ab ? ab.split(/\s+/).map(Number) : [0, 0]
result(ahead === 0 && behind === 0 ? 'PASS' : 'WARN', '与 origin/main 同步', `ahead=${ahead} behind=${behind}`)
result(existsSync(join(ROOT, 'node_modules')) ? 'PASS' : 'SKIP', 'node_modules 就绪', '')

// ── F. 编译验证 ──────────────────────────────────────────
group('F. 编译验证')
if (quick) {
  result('SKIP', 'tsc --noEmit', '--quick 模式跳过')
  result('SKIP', 'electron-vite build', '--quick 模式跳过')
} else {
  const t1 = sh('npx tsc --noEmit')
  result(t1.ok ? 'PASS' : 'FAIL', 'TypeScript 类型检查', t1.error || '')
  const t2 = sh('npx electron-vite build')
  result(t2.ok ? 'PASS' : 'FAIL', 'electron-vite 构建', t2.error || '')
}

// ── G. 需人工确认事项 ────────────────────────────────────
group('G. 需人工确认事项（机器无法自动化）')
manualItem('旧数据升级回归', '用真实 0.x 数据目录启动新版：API 密钥加密、对话/知识库/技能完整性、解锁流程')
manualItem('双机跨系统数据互通', '同一 U 盘：Windows 便携版写入数据 → Linux AppImage 打开 → 数据/密钥完整，再反向验证')
manualItem('杀软环境实测', '腾讯电脑管家等国产杀软下启动/网络服务是否误杀（信任区引导）')
manualItem('锁屏与加密联动手测', 'Ctrl+L 锁定 → 主密码解锁 → 自动锁屏超时生效')
manualItem('Release 演练后复查', '发布 tag 后核对 Release 资产：2 个 exe + AppImage + 2 份 latest*.yml + blockmap；旧版本应用能检测到新 Release')

// ── 输出报告 ─────────────────────────────────────────────
const icon = { PASS: '✓', FAIL: '✗', WARN: '!', SKIP: '-', MANUAL: '?' }
let out = '\n========== 墨匣发布前检查报告 ==========\n'
for (const r of rows) {
  if (r.type === 'group') { out += `\n── ${r.title}\n`; continue }
  out += `  ${icon[r.status]} ${r.status.padEnd(6)} ${r.name}${r.detail ? `  · ${r.detail}` : ''}\n`
}
out += `\n=============================================\n`
out += `  通过 ${pass} · 失败 ${fail} · 警告 ${warn} · 跳过 ${skip} · 需人工 ${manual}\n`
out += fail > 0 ? `  ✗ 存在失败项，不能发布\n` : warn > 0 ? `  ⚠ 失败项为零，请核对警告与人工项\n` : `  ✓ 全部通过，可进入发布流程\n`
console.log(out)
process.exit(fail > 0 ? 1 : 0)
