// 将 dist 中的最终安装包收拢到 artifacts/，让所有平台的客户端统一在一个文件夹
// （dist 同时也是 electron-builder 的暂存目录，混有 linux-unpacked 等中间产物，不作对外目录）
const fs = require('node:fs')
const path = require('node:path')

const distDir = path.join(__dirname, '..', 'dist')
const outDir = path.join(__dirname, '..', 'artifacts')
const INSTALLER_EXT = ['.exe', '.AppImage', '.deb', '.rpm']
const META_NAME = /^latest.*\.yml$/
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])
const RETRY_ATTEMPTS = 12
const RETRY_DELAY_MS = 500

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Windows 上目标文件可能被杀软/资源管理器短暂占用：先写同目录临时文件，再重试 rename。 */
function copyFileWithRetry(src, dest, label) {
  const tmp = `${dest}.pocketai-tmp`
  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      fs.copyFileSync(src, tmp)
      fs.renameSync(tmp, dest)
      return
    } catch (e) {
      fs.rmSync(tmp, { force: true })
      const code = e && e.code
      if (!RETRY_CODES.has(code) || attempt === RETRY_ATTEMPTS) throw e
      console.log(
        `[collect-installers] ${label} 暂被占用（${code}），${RETRY_DELAY_MS}ms 后重试 ${attempt + 1}/${RETRY_ATTEMPTS}`
      )
      sleep(RETRY_DELAY_MS)
    }
  }
}

if (!fs.existsSync(distDir)) {
  console.log('[collect-installers] dist 不存在，跳过')
  process.exit(0)
}
fs.mkdirSync(outDir, { recursive: true })

let n = 0
for (const f of fs.readdirSync(distDir)) {
  const p = path.join(distDir, f)
  if (!fs.statSync(p).isFile()) continue
  if (!INSTALLER_EXT.includes(path.extname(f)) && !META_NAME.test(f)) continue
  const dest = path.join(outDir, f)
  copyFileWithRetry(p, dest, f)
  // AppImage 双击运行需要可执行位（copyFileSync 不保留 mode）
  if (path.extname(f) === '.AppImage') fs.chmodSync(dest, 0o755)
  console.log('[collect-installers]', f, '→ artifacts/')
  n++
}

// 一键启动器 + 桌面启动器 + 使用说明：与 AppImage 同目录分发
const EXTRA_FILES = ['启动墨匣.sh', '墨匣.desktop', '使用说明.txt']
for (const name of EXTRA_FILES) {
  const src = path.join(__dirname, '..', 'build', name)
  if (!fs.existsSync(src)) continue
  const dest = path.join(outDir, name)
  copyFileWithRetry(src, dest, name)
  if (name.endsWith('.sh') || name.endsWith('.desktop')) fs.chmodSync(dest, 0o755)
  console.log('[collect-installers]', name, '→ artifacts/')
  n++
}
console.log(`[collect-installers] 共收拢 ${n} 个文件到 artifacts/`)
