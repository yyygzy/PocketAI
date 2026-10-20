// 在途 shell_exec 子进程的退出登记（V4-Iter-202）：真 spawn、真杀，不桩 child_process
//
// V4-Iter-240 在这一条文件上补了三件事，都不是产品改动，而是"用例自己被砍时不许留下副作用"：
//  ① 心跳文件名带本 worker 的 pid ⇒ 上一轮跑批留下的孤儿进程写的是**它的**文件，染不到这一轮
//     （今天两次全量红两条，第一次的成因就是这个共享固定文件名＋残留进程）；
//  ② afterEach 兜底杀在途 job：用例被超时砍在中间时，那发 `node hb.js` 以前会一直活着——
//     既把下一条"自然结束"的计数连带弄红，又把孤儿留在机器上污染下一次跑批；
//  ③ 三条真 spawn 的用例各自放宽超时到 20s（默认 5s 对"700ms＋900ms＋真 taskkill"太紧，
//     负载高时直接被砍——复现法见台账 §240：`--testTimeout=1000` 能打出同样那两条红）。
import { describe, it, expect, vi, beforeAll, afterEach, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

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
/**
 * 心跳文件名带 worker pid 与用例标签，两层都是必要的：
 *  - pid 挡住上一轮跑批留下的孤儿进程写脏这一轮的判据（§240 的起因）；
 *  - 标签挡住同一 worker 内的互相污染——上一条迟到的子进程只写它自己那一条的字，
 *    不会把下一条的「字节数不再增长」顶红（我第一次就栽在共用一个文件上）。
 */
const hbPath = (tag: string): string => path.join(WS, `hb-${process.pid}-${tag}.txt`)
const HB = hbPath('long')
const LEAK_HB = hbPath('leak')

beforeAll(() => {
  fs.mkdirSync(WS, { recursive: true })
  // 心跳脚本：活着就每 200ms 往指定文件追加一个字节 ⇒ "树里的人是否真死了"可直接观测
  // （不用退出码判：Windows 下 taskkill /T /F 之后 cmd 壳回的是 0，退出码在这里没有信息量）
  fs.writeFileSync(
    path.join(WS, 'hb.js'),
    'const f=require("fs");const p=process.argv[2];f.writeFileSync(p,"x");setInterval(()=>f.appendFileSync(p,"x"),200)\n',
    'utf8'
  )
  for (const f of fs.readdirSync(WS)) if (f.startsWith(`hb-${process.pid}-`)) fs.rmSync(path.join(WS, f), { force: true })
  repo.__kv.clear()
  repo.__kv.set('agent.workspace_dir', WS)
  repo.__kv.set('agent.shell_enabled', '1')
  repo.__kv.set('agent.shell_policy', 'auto-safe')
})

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 等到心跳文件真的出现：子进程冷启动可以远超一个固定 sleep，等不到就是它没跑起来 */
async function waitFile(file: string, ms = 8000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fs.existsSync(file)) return true
    await wait(50)
  }
  return false
}

/**
 * 还有谁在写这个心跳文件 —— 直接问操作系统，不去看文件字节增长。
 * 为什么换：V4-Iter-240 那版的判据是「600ms 内字节数不变」，本质是在赌调度：满载机器上一次
 * taskkill 的生效可以慢过 600ms，于是判据把「杀得慢」读成了「没杀掉」（当时红的正是两条）。
 * 这个查询回答另一件事：此刻还有没有活着的、命令行里带着我这个唯一文件名的进程。
 * 注意：只过滤 node.exe（本用例的心跳就是 node），换别的被测进程时这个 Name 要跟着改。
 */
function liveHeartbeatPids(fileName: string): number[] {
  const ps =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    "Where-Object { $_.CommandLine -like '*" + fileName + "*' } | Select-Object -ExpandProperty ProcessId"
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf-8' })
  return out
    .split(/\r?\n/)
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0)
}

/** 等到一个心跳进程都查不到（有界；等的是状态，不是「文件安静了一会儿」） */
async function waitNoHeartbeat(fileName: string, ms = 8000): Promise<{ ok: boolean; pids: number[] }> {
  const until = Date.now() + ms
  let pids: number[] = []
  while (Date.now() < until) {
    pids = liveHeartbeatPids(fileName)
    if (pids.length === 0) return { ok: true, pids }
    await wait(250)
  }
  return { ok: false, pids }
}

/** 反向对照用的"看得见"：判据说「查不到」之前，先证明这条查询查得到活着的 */
async function waitHeartbeatSeen(fileName: string, ms = 8000): Promise<number[]> {
  const until = Date.now() + ms
  let pids: number[] = []
  while (Date.now() < until) {
    pids = liveHeartbeatPids(fileName)
    if (pids.length > 0) return pids
    await wait(250)
  }
  return pids
}

async function waitCount(target: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (inFlightShellJobCount() === target) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return inFlightShellJobCount() === target
}

/**
 * 兜底：每条用例跑完都把在途 job 杀干净，**等它真的从登记表里消失**再放行下一条。
 * 这一条是 §240 的核心——用例被超时砍在 `await` 中间时，那发心跳子进程以前会一直活着：
 * 下一条"自然结束"的用例就读到 `inFlightShellJobCount() === 1`，连带红；
 * 而跑批结束后它还替这台机器继续往心跳文件追加，把下一次跑批的判据也弄脏。
 */
afterEach(async () => {
  killInFlightShellJobs()
  await waitCount(0, 8000)
})

const shellTool = () => {
  const tools = getShellTools()
  expect(tools.map((t) => t.schema.id)).toEqual(['shell.exec'])
  return tools[0]!
}

describe('在途 shell 子进程的退出登记', () => {
  it('工具确实注册了（工作目录 + 开关都齐）', () => {
    expect(shellTool().schema.name).toBe('shell_exec')
  })

  it('长跑命令期间登记在案；kill 之后整棵树停止心跳（孙进程不是孤儿）', { timeout: 45_000 }, async () => {
    const p = shellTool().execute({ command: `node hb.js ${path.basename(HB)}`, timeoutMs: 20000 })
    expect(await waitCount(1)).toBe(true)
    // 等它真的开始写：上一次就是在这里假红的——固定 700ms 撞上慢启动，文件还没被创建
    expect(await waitFile(HB), '子进程 8s 内一次都没写 ⇒ 它根本没跑起来').toBe(true)
    expect(fs.statSync(HB).size).toBeGreaterThan(0)

    expect(killInFlightShellJobs()).toBe(1)
    await p // 命令壳应随即结束（不等到 8s/20s）
    expect(await waitCount(0)).toBe(true)
    // 判据：查不到任何还在写这个心跳文件的进程（不再拿「字节数安静了一会儿」当证据）
    const quiet = await waitNoHeartbeat(path.basename(HB))
    expect(quiet.pids, 'kill 之后仍有心跳进程活着：' + quiet.pids.join(',')).toEqual([])
  })

  it('正向对照：命令自然结束后登记自己摘掉，此时 kill 返回 0（不谎报"杀了几个"）', { timeout: 45_000 }, async () => {
    const raw = await shellTool().execute({ command: 'node -e "setTimeout(()=>{},200)"', timeoutMs: 10000 })
    const res = JSON.parse(raw) as { exitCode: number | null }
    expect(res.exitCode).toBe(0)
    expect(inFlightShellJobCount()).toBe(0)
    expect(killInFlightShellJobs()).toBe(0)
  })
})

// 兜底本身也要有用例盯着——否则"摘掉 afterEach"这种改动是**空真**的：
// 前面每条用例都自己 kill 了，登记表本来就空，你删掉兜底它照样全绿。
// 所以这里**故意留一个在途 job 不自己杀**，让下一条去读兜底的结果。
describe('用例被砍在中间时，兜底必须收干净（§240 的那三件事）', () => {
  it('故意留下一发在跑的心跳：既不 await 也不 kill，交给 afterEach', { timeout: 45_000 }, async () => {
    void shellTool()
      .execute({ command: `node hb.js ${path.basename(LEAK_HB)}`, timeoutMs: 20000 })
      .catch(() => { /* 被兜底杀掉时壳会带回错误串，这条用例不关心 */ })
    // 等到它确实登记上——这一步保证下一条**不是空真**（没登记上就归零，等于什么都没测）
    expect(await waitCount(1, 4000)).toBe(true)
    // 反向对照：这一会儿进程明明是活的——查询要是返回空，就得在这里露馅，而不是让下一条的
    // 「查不到」变成假绿（`liveHeartbeatPids` 写坏了也会一路绿灯）
    expect((await waitHeartbeatSeen(path.basename(LEAK_HB))).length).toBeGreaterThan(0)
  })

  it('上一条之后：登记表已归零，且查不到还在写心跳的进程（杀的是整棵树，不只是解注册）', { timeout: 45_000 }, async () => {
    expect(inFlightShellJobCount()).toBe(0)
    // 只看本条用例自己那一个心跳文件：上一条迟到的子进程写的是它自己的字，染不到这里
    expect(fs.existsSync(LEAK_HB) ? fs.statSync(LEAK_HB).size : 0).toBeGreaterThan(0)
    const quiet = await waitNoHeartbeat(path.basename(LEAK_HB))
    expect(quiet.pids, 'afterEach 兜底没把树杀干净，还活着：' + quiet.pids.join(',')).toEqual([])
  })
})

afterAll(() => {
  // 本 worker 的心跳文件全收走（别的 pid 留下的不属于我，也不许来染我）
  for (const f of fs.readdirSync(WS)) if (f.startsWith(`hb-${process.pid}-`)) fs.rmSync(path.join(WS, f), { force: true })
})
