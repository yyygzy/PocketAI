// 在途 shell_exec 子进程的退出登记（V4-Iter-202）：真 spawn、真杀，不桩 child_process
import { describe, it, expect, vi, beforeAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('../src/main/db/repositories/app-config.repo', () => {
  const kv = new Map<string, string>()
  return {
    appConfigRepo: {
      get: (key: string) => kv.get(key) ?? null,
      set: (key: string, value: string) => { kv.set(key, value) },
      delete: (key: string) => { kv.delete(key) }
    },
    __kv: kv
  }
})

// §231 后 fs-tools 会经 agent/file-snapshots 拉进 portable（顶层算 APP_ROOT 要用 app.isPackaged）
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '', getAppPath: () => process.cwd() }
}))

import { getShellTools, inFlightShellJobCount, killInFlightShellJobs } from '../src/main/tools/shell-tools'
import * as repoMod from '../src/main/db/repositories/app-config.repo'
const repo = repoMod as unknown as { __kv: Map<string, string> }

const WS = path.resolve(__dirname, '../data/tmp/shell-jobs')
const HB = path.join(WS, 'hb.txt')

beforeAll(() => {
  fs.mkdirSync(WS, { recursive: true })
  // 心跳脚本：活着就每 200ms 往 hb.txt 追加一个字节 ⇒ "树里的人是否真死了"可直接观测
  // （不用退出码判：Windows 下 taskkill /T /F 之后 cmd 壳回的是 0，退出码在这里没有信息量）
  fs.writeFileSync(
    path.join(WS, 'hb.js'),
    'const f=require("fs");f.writeFileSync("hb.txt","x");setInterval(()=>f.appendFileSync("hb.txt","x"),200)\n',
    'utf8'
  )
  fs.rmSync(HB, { force: true })
  repo.__kv.clear()
  repo.__kv.set('agent.workspace_dir', WS)
  repo.__kv.set('agent.shell_enabled', '1')
  repo.__kv.set('agent.shell_policy', 'auto-safe')
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitCount(target: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (inFlightShellJobCount() === target) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return inFlightShellJobCount() === target
}

const shellTool = () => {
  const tools = getShellTools()
  expect(tools.map((t) => t.schema.id)).toEqual(['shell.exec'])
  return tools[0]!
}

describe('在途 shell 子进程的退出登记', () => {
  it('工具确实注册了（工作目录 + 开关都齐）', () => {
    expect(shellTool().schema.name).toBe('shell_exec')
  })

  it('长跑命令期间登记在案；kill 之后整棵树停止心跳（孙进程不是孤儿）', async () => {
    const p = shellTool().execute({ command: 'node hb.js', timeoutMs: 20000 })
    expect(await waitCount(1)).toBe(true)
    await wait(700) // 至少写两三拍
    expect(fs.statSync(HB).size).toBeGreaterThan(0)

    expect(killInFlightShellJobs()).toBe(1)
    await p // 命令壳应随即结束（不等到 8s/20s）

    const sizeAtKill = fs.statSync(HB).size
    await wait(900)
    expect(fs.statSync(HB).size).toBe(sizeAtKill) // 心跳没继续长 ⇒ 树里已经没有活进程
    expect(await waitCount(0)).toBe(true)
  })

  it('正向对照：命令自然结束后登记自己摘掉，此时 kill 返回 0（不谎报"杀了几个"）', async () => {
    const raw = await shellTool().execute({ command: 'node -e "setTimeout(()=>{},200)"', timeoutMs: 10000 })
    const res = JSON.parse(raw) as { exitCode: number | null }
    expect(res.exitCode).toBe(0)
    expect(inFlightShellJobCount()).toBe(0)
    expect(killInFlightShellJobs()).toBe(0)
  })
})
