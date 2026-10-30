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
import { preflight, readCdpPort } from '../scripts/ui-verify-launch.mjs'

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

// §366：读端口那一颗。立项理由是一次真事故——我用这台启动闸门起 scratch 实例，
// `existsSync` 之后直接 `readFileSync`，而 Windows 上 Electron 独占锁着 `DevToolsActivePort`
// ⇒ `EBUSY: resource busy or locked` 把闸门自己打崩，`stdio: 'inherit'` 之下我起的实例跟着没了，
// 那一趟连"root 有没有生效"都没读到。闸门是拦人的，它自己不许被一次锁吃掉。
describe('④ 读 CDP 端口：锁住时要能继续等，且不许哑', () => {
  const PF = 'C:/nowhere/DevToolsActivePort'
  const errFs = (code: string): unknown => ({
    readFileSync: () => {
      throw Object.assign(new Error(code + ': resource busy or locked, open ' + PF), { code })
    }
  })

  it.each([
    ['EBUSY（Electron 正锁着这份文件＝本批撞中的那颗）', 'EBUSY'],
    ['EPERM', 'EPERM'],
    ['EAGAIN', 'EAGAIN'],
    ['ENOENT（还没写出来）', 'ENOENT']
  ])('%s ⇒ 不抛穿、报"还没读到"并留着错误文本', (_what, code) => {
    const r = readCdpPort(errFs(code) as never, PF)
    expect(r.port, code + ' 竟然读出一个端口').toBeNull()
    expect(r.error, code + ' 被咽掉了＝超时时说不出为什么').toContain(code)
  })

  it('抛出对象连 code 都没有（非典型错误）⇒ 也不许抛穿，归成 UNKNOWN', () => {
    const r = readCdpPort({ readFileSync: () => { throw new Error('boom') } } as never, PF)
    expect(r.port).toBeNull()
    expect(r.error).toContain('UNKNOWN')
  })

  it('空文件／只有空白 ⇒ 算"还没读到"，不许把空串当端口报上去', () => {
    for (const raw of ['', '\n', '   \n']) {
      const r = readCdpPort({ readFileSync: () => raw } as never, PF)
      expect(r.port, JSON.stringify(raw) + ' 竟然算读到了').toBeNull()
    }
  })

  it('正向对照：正常那份内容取的是第一行（反向钉子——上面四颗若写过头，这里就红）', () => {
    const r = readCdpPort({ readFileSync: () => '9371\n/devtools/browser/abc\n' } as never, PF)
    expect(r.port).toBe('9371')
    expect(r.error).toBeNull()
  })
})

// §366 撞出来的另一档：`.mjs` 不参与 tsc 检查，用例 import 到的是**手抄的 `.d.mts`**——
// 我加了 `readCdpPort` 却忘了补声明，tsc 只报一句"没有这个导出成员"，看起来像代码写错而不是声明漏抄。
// ⇒ 两头钉：声明里写的必须真导出、真导出的必须写进声明（这份文件没有豁免名单）。
describe('⑤ 手抄的 .d.mts 与 .mjs 的导出名必须成对', () => {
  const names = (src: string): string[] =>
    src.split('\n').map((l) => /^export function (\w+)/.exec(l)?.[1]).filter((x): x is string => !!x).sort()
  const impl = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ui-verify-launch.mjs'), 'utf-8').replace(/\r\n/g, '\n')
  const decl = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ui-verify-launch.d.mts'), 'utf-8').replace(/\r\n/g, '\n')

  it('两侧名单逐字相同（多了＝抄漏，少了＝声明在骗 tsc）', () => {
    expect(names(decl), '声明里的名字').toEqual(names(impl))
    expect(names(impl).length, '判据函数总数（新增要连声明一起补）').toBe(2)
  })
})
