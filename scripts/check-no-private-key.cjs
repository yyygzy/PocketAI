'use strict'

// SEC-16-02 · 打包前拦截：发行私钥绝不允许留在交付工作区。
//
// 背景：build/license-private.pem 与 src/main/license/public-key.ts 内置的生产公钥
// 逐字节配对，任何取得它的人（外发承包商、CI 缓存、桌面同步盘、误打包）即等价于
// 持有发行方身份，可签发任意 plan / expires_at / features 的许可证。
// .gitignore 只挡 git，挡不住「目录整体外发」与误打包，所以这里在五个 dist 脚本链
// 入口硬拦一发（与 check-license-url.cjs 同级、同风格）。
//
// 约定：本脚本只负责拦截，不删除任何文件——移除私钥是用户的运维动作
// （改由 CI Secret / HSM / 离线签名机持有）。发现私钥 → 中文报错 + exit 1。
//
// 用法：node scripts/check-no-private-key.cjs [--dir <目录>]（默认 process.cwd()，
// --dir 主要给测试注入临时目录用）。

const fs = require('fs')
const path = require('path')

// 解析 --dir 参数（默认当前目录）
let dir = process.cwd()
const args = process.argv.slice(2)
const dirIdx = args.indexOf('--dir')
if (dirIdx !== -1 && typeof args[dirIdx + 1] === 'string' && args[dirIdx + 1] !== '') {
  dir = args[dirIdx + 1]
}

// 文档指定的三个私钥落点（相对仓库根 / --dir）
const FORBIDDEN = [
  'build/license-private.pem',
  'license-private.pem',
  'license-server/license-private.pem'
]

const found = []
for (const rel of FORBIDDEN) {
  const abs = path.resolve(dir, rel)
  if (fs.existsSync(abs)) found.push({ rel, abs })
}

if (found.length > 0) {
  for (const f of found) {
    console.error(`[FATAL] 发行私钥存在于交付目录: ${f.rel}（${f.abs}）`)
  }
  console.error(
    '[FATAL] 私钥等同发行方身份，可签发任意许可证。请把它移到 CI Secret / HSM / 离线签名机' +
      '（发行流水线只在签名步骤临时挂载）并轮换密钥对后，重新执行打包。'
  )
  process.exit(1)
}

console.log('[check-no-private-key] 未发现发行私钥，校验通过')
process.exit(0)
