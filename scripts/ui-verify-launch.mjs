#!/usr/bin/env node
// 真机自查（UI 验证）的启动闸门。
//
// 为什么要有这个文件——2026-10-20 19:14 出过一次事：我用 bash 套 PowerShell 传环境变量
// （powershell -Command "$env:POCKETAI_APP_ROOT='…'; Start-Process …"），bash 把 `$env:…`
// 当成自己的变量吃掉了，PowerShell 收到的是一句空赋值 ⇒ 环境变量从未生效。
// 那台实例于是打开了**真实 data/app.db**（`--user-data-dir="C:\PocketAI\data\userdata"`），
// 还弹了**真实库的置顶解锁窗**，日志里随后是 `DB 解锁成功`——有人往那个窗口里输了真主密码。
// 台账 V4-Iter-239 记的是这件事。
//
// 所以规矩不能只写在文档里，得拦得住人：
//  ① 环境变量由本进程自己写进 child env，不再经过任何 shell 拼串；
//  ② root 必须是 `<仓库>/data/` 之下的一个目录，且**里面不许有 app.db / -wal / -shm**——
//     空 root = none 模式 = 走首启向导，**根本不会弹解锁窗**，不给真人输密码的机会；
//  ③ 起完必须能在 `<root>/data/userdata/DevToolsActivePort` 读到端口：读不到就是 root 没生效，
//     立刻杀掉自己起的进程并退出，不做任何后续操作。
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

/**
 * 纯判定：给出候选 root 与调试端口，返回能不能起、以及为什么不能起。
 * 与"起进程"分开，是为了让这层判断可被单测钉住（不必真起一个 Electron）。
 */
export function preflight(root, port) {
  const errors = []
  const p = Number(port)
  if (!Number.isInteger(p) || p < 1024 || p > 65535) {
    errors.push(`--port 要是一个 1024–65535 的整数（拿到 ${JSON.stringify(port)}）`)
  }
  if (!root) {
    errors.push('--root 必填（scratch app root，会原样写进子进程的 POCKETAI_APP_ROOT）')
    return { ok: false, errors }
  }
  const abs = path.resolve(REPO_ROOT, root)
  const realData = path.join(REPO_ROOT, 'data')
  // 只有一条判据：必须在 `<仓库>/data/` **之下**。真实 data 目录本身不在自己之下，所以同样被拒——
  // 这里曾多写一句 `abs !== realData`，变异 G1 打了它一下用例全绿，证明那是死码，已删。
  if (!abs.startsWith(realData + path.sep)) {
    errors.push(
      `root 必须在 ${realData} **之下**（真实 data 目录本身也不行）：拿到 ${abs}`
    )
    return { ok: false, errors }
  }
  const dataDir = path.join(abs, 'data')
  // 只看"有没有库文件"这一件事，不读库里任何内容：真实库按约定是不可读的用户数据
  const dbFiles = ['app.db', 'app.db-wal', 'app.db-shm'].filter((f) => fs.existsSync(path.join(dataDir, f)))
  if (dbFiles.length > 0) {
    errors.push(
      `scratch root 里已有 ${dbFiles.join(' / ')}：那可能是一份真库（会弹解锁窗）。换一个空 root，或先自己确认它是你哪次留下的`
    )
  }
  return { ok: errors.length === 0, errors, abs, dataDir }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = (name) => {
    const i = argv.indexOf('--' + name)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const root = flag('root')
  const port = flag('port')
  const dryRun = argv.includes('--dry-run')

  const plan = preflight(root, port)
  for (const e of plan.errors) console.error('拒绝：' + e)
  if (!plan.ok) process.exit(1)

  console.log(`POCKETAI_APP_ROOT = ${plan.abs}`)
  console.log(`DATA_DIR          = ${plan.dataDir}`)
  console.log(`remote-debugging-port = ${port}`)
  if (dryRun) {
    console.log('--dry-run：只做前置判定，不起进程')
    return

  }
  const exe = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const child = spawn(exe, [REPO_ROOT, `--remote-debugging-port=${port}`], {
    env: { ...process.env, POCKETAI_APP_ROOT: plan.abs },
    stdio: 'inherit'
  })

  const portFile = path.join(plan.dataDir, 'userdata', 'DevToolsActivePort')
  const deadline = Date.now() + 20_000
  const timer = setInterval(() => {
    if (fs.existsSync(portFile)) {
      clearInterval(timer)
      // 端口文件的第一行就是实际监听的端口（比命令行那个更可信）
      console.log('root 已生效，CDP 端口：' + fs.readFileSync(portFile, 'utf-8').split('\n')[0].trim())
      return
    }
    if (Date.now() > deadline) {
      clearInterval(timer)
      console.error(`${portFile} 20s 内没出现 ⇒ POCKETAI_APP_ROOT 没生效，立刻收手（杀掉自己起的进程）`)
      child.kill()
      process.exit(2)
    }
  }, 500)

  child.on('exit', (code) => process.exit(code ?? 0))
}

// 只有被直接执行时才跑 main()——preflight 要能被单测 import 走
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main()
}
