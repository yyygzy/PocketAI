// macOS Notarization 钩子（afterSign）
// ── 等 Apple Developer Program 开通 + Developer ID 证书后启用 ──
//
// 前置：npm install --save-dev electron-notarize
// 启用：package.json mac 段取消注释 "afterSign": "scripts/notarize.js"
// CI Secrets（GitHub Repo Settings → Secrets and variables → Actions）：
//   APPLE_ID                  = your@icloud.com
//   APPLE_APP_SPECIFIC_PASSWORD = abcd-efgh-ijkl-mnop（Apple ID → 安全 → 专用密码）
//   APPLE_TEAM_ID             = ABCD123456（开发者团队 ID）
//
// 本地测试：先把 Developer ID 证书导入钥匙串
//   security import certificate.p12 -k ~/Library/Keychains/login.keychain-db -P "$CSC_KEY_PASSWORD" -A
//   security set-key-partition-list -S apple-tool:,apple: -s -k <keychain-password> ~/Library/Keychains/login.keychain-db
// 然后跑：CSC_KEY_PASSWORD=xxx npx electron-builder --mac

const { notarize } = require('electron-notarize')

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context
  if (electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = `${appOutDir}/${appName}.app`

  // 无证书环境变量 → 跳过 notarization（本地/未签名构建时安全退出）
  if (!process.env.APPLE_ID || !process.env.APPLE_APP_SPECIFIC_PASSWORD) {
    console.log('[notarize] 未配置 APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD，跳过 notarization')
    return
  }

  console.log(`[notarize] 正在 notarize ${appPath}...`)
  await notarize({
    appBundleId: 'ai.pocket.desktop',
    appPath,
    appleId: process.env.APPLE_ID,
    appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
    teamId: process.env.APPLE_TEAM_ID,
  })
  console.log('[notarize] ✅ 通过')
}
