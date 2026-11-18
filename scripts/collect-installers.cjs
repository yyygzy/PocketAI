// 将 dist 中的最终安装包收拢到 artifacts/，让所有平台的客户端统一在一个文件夹
// （dist 同时也是 electron-builder 的暂存目录，混有 linux-unpacked 等中间产物，不作对外目录）
const fs = require('node:fs')
const path = require('node:path')

const distDir = path.join(__dirname, '..', 'dist')
const outDir = path.join(__dirname, '..', 'artifacts')
const INSTALLER_EXT = ['.exe', '.AppImage', '.deb', '.rpm']
const META_NAME = /^latest.*\.yml$/

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
  fs.copyFileSync(p, dest)
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
  fs.copyFileSync(src, dest)
  if (name.endsWith('.sh') || name.endsWith('.desktop')) fs.chmodSync(dest, 0o755)
  console.log('[collect-installers]', name, '→ artifacts/')
  n++
}
console.log(`[collect-installers] 共收拢 ${n} 个文件到 artifacts/`)
