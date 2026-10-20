// @vitest-environment node
// 真机自查启动闸门的前置判定（V4-Iter-239）
//
// 这份判据不是便利函数，是**一次事故的直接产物**：2026-10-20 19:14 我用 bash 套 PowerShell
// 传 POCKETAI_APP_ROOT，`$env:…` 被 bash 吃掉 ⇒ 环境变量从未生效，那台实例打开了**真实 data/app.db**
// 并弹出真实库的置顶解锁窗（日志随后是 `DB 解锁成功`）。台账 V4-Iter-239 记全过程。
// 规矩要能被 CI 挡住，否则换个人写命令照样漏：
//  ① 真实 data 目录永远不是 scratch root，仓库之外也不行；
//  ② scratch root 里只要有一个 `app.db`（含 -wal / -shm）就拒——**只看存在性，绝不读内容**
//     （那份库按约定是不可读的用户数据）；空 root 才安全：none 模式走首启向导，压根不弹解锁窗；
//  ③ 端口要落在 1024–65535。
//
// 用例造的 root 都在 `data/tmp/ci-239-*` 下（判据本身就要求 root 落在 `data/` 之下），跑完删掉。
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { preflight } from '../scripts/ui-verify-launch.mjs'

const CI_ROOTS = path.join(process.cwd(), 'data', 'tmp')

/** 造一个 scratch root：files 是它 data/ 下要有的文件名 */
function makeRoot(name: string, files: string[] = []): string {
  const root = path.join('data', 'tmp', name)
  const data = path.join(process.cwd(), root, 'data')
  fs.mkdirSync(data, { recursive: true })
  for (const f of files) fs.writeFileSync(path.join(data, f), '')
  return root
}

afterAll(() => {
  for (const name of fs.readdirSync(CI_ROOTS)) {
    if (name.startsWith('ci-239-')) fs.rmSync(path.join(CI_ROOTS, name), { recursive: true, force: true })
  }
})

describe('① 真实 data 目录与仓库之外的路径，一律不是 scratch root', () => {
  it('直接给 data 本身 ⇒ 拒（正是 19:14 那次踩中的那一条）', () => {
    const r = preflight('data', '9237')
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('之下')
  })

  it.each([
    ['仓库之外的绝对路径', 'C:\\Windows\\Temp'],
    ['靠 .. 爬出去', '../elsewhere'],
    ['根本没给', undefined]
  ])('%s ⇒ 拒', (_what, root) => {
    expect(preflight(root as string | undefined, '9237').ok).toBe(false)
  })

  it('反向对照：真实 data 之下的一个空子目录才算数（不是"路径里带 data 就拒"）', () => {
    const root = makeRoot('ci-239-empty')
    const r = preflight(root, '9237')
    expect(r.ok, r.errors.join(' ')).toBe(true)
    expect(r.abs).toBe(path.join(process.cwd(), 'data', 'tmp', 'ci-239-empty'))
    expect(r.dataDir).toBe(path.join(process.cwd(), 'data', 'tmp', 'ci-239-empty', 'data'))
  })
})

describe('② root 里只要有任何库文件就拒，且只看存在性', () => {
  it.each(['app.db', 'app.db-wal', 'app.db-shm'])('只有 %s（0 字节的空文件）也照样拒', (file) => {
    const root = makeRoot('ci-239-' + file, [file])
    const r = preflight(root, '9237')
    expect(r.ok, file + ' 竟然放行了').toBe(false)
    expect(r.errors.join(' ')).toContain(file)
  })

  it('只有 userdata / 日志 ⇒ 放行（判据盯的是库文件，不是"这目录被用过"）', () => {
    const root = makeRoot('ci-239-used')
    const data = path.join(process.cwd(), root, 'data')
    fs.mkdirSync(path.join(data, 'userdata'), { recursive: true })
    fs.writeFileSync(path.join(data, 'userdata', 'DevToolsActivePort'), '9237\n')
    fs.mkdirSync(path.join(data, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(data, 'logs', 'main.log'), '')
    expect(preflight(root, '9237').ok).toBe(true)
  })
})

describe('③ 端口', () => {
  it.each([
    ['小于 1024', '99'],
    ['大于 65535', 70000],
    ['不是数字', 'abc'],
    ['非整数', 9237.5],
    ['没给', undefined]
  ])('%s ⇒ 拒', (_what, port) => {
    const r = preflight(makeRoot('ci-239-empty'), port as string | number | undefined)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toContain('--port')
  })

  it('边界 1024 与 65535 都收', () => {
    const root = makeRoot('ci-239-empty')
    expect(preflight(root, 1024).ok).toBe(true)
    expect(preflight(root, 65535).ok).toBe(true)
  })
})
