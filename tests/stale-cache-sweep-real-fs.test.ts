// V4-Iter-193 遗留浏览器缓存清扫：真临时目录、真删除，断言按约定写而不是按实现写
//
// 三条要证的约定：
//  · **只碰那两个目录名**（Cache／Code Cache），Dictionaries（spellcheck 词典，删了要联网重下）绝不进射程；
//  · **新鲜度闸门看的是"活动"**——目录本身旧、但直接子目录今天被写过 ⇒ 那是活的，不删（反向对照让两种假说算出不同的数）；
//  · **删了多少要说实话**：freed 只统计真删掉的文件，被占用跳过的计入 busy，不谎报成释放。
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const BS = String.fromCharCode(92)
  const sep = base.indexOf(BS) >= 0 ? BS : '/'
  const root = base + sep + 'pocketai-sweep193'
  process.env.POCKETAI_APP_ROOT = root
  const data = root + sep + 'data'
  return { root, data, userdata: data + sep + 'userdata' }
})
// 活根（app.getPath('userData')）必须能与 DATA_DIR 下的两棵档案树区分开，
// 194 那条"活根之下不删"才有可测的形状
vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => P.root,
    getPath: (name: string) => (name === 'userData' ? P.userdata : P.root)
  }
}))

import {
  cacheDirCandidates,
  findStagingLeftovers,
  liveProfileRoot,
  pickStaleTargets,
  removeTree,
  sweepGivenTargets,
  sweepStaleProfileCaches
} from '../src/main/steward/stale-cache-sweep'

const DAY = 24 * 60 * 60 * 1000

function makeCache(dir: string, files: Array<[string, number]>): number {
  fs.mkdirSync(dir, { recursive: true })
  let bytes = 0
  for (const [name, size] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 7))
    bytes += size
  }
  return bytes
}

/** 把一个目录"变旧"：它自己与里面每个文件都退到 daysAgo 天前 */
function backdate(dir: string, daysAgo: number): void {
  const t = (Date.now() - daysAgo * DAY) / 1000
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) backdate(p, daysAgo)
    fs.utimesSync(p, t, t)
  }
  fs.utimesSync(dir, t, t)
}

function touchDir(dir: string): void {
  const now = Date.now() / 1000
  fs.utimesSync(dir, now, now)
}

const scratch = (name: string): string => path.join(P.data, name.split('/').join(path.sep))
/** 用例里显式传的活根，与 mock 的 app.getPath 一致 */
const LIVE = P.userdata

beforeAll(() => {
  fs.rmSync(P.data, { recursive: true, force: true })
  // 活根与它的活缓存（190 实测的落点）：闸门要求它存在，否则一律不动
  makeCache(path.join(LIVE, 'Cache'), [['Cache_Data/data_0', 1024]])
})

afterAll(() => {
  fs.rmSync(P.data, { recursive: true, force: true })
})

describe('射程（约定：只有那两个目录名）', () => {
  it('候选恰好是两棵档案树 × Cache／Code Cache，且都在 DATA_DIR 内', () => {
    const rel = cacheDirCandidates().map((p) => path.relative(P.data, p).split(path.sep).join('/'))
    expect(rel).toEqual(['userdata/Cache', 'userdata/Code Cache', 'session/Cache', 'session/Code Cache'])
    for (const p of cacheDirCandidates()) expect(p.startsWith(P.data + path.sep)).toBe(true)
  })

  it('spellcheck 词典那类目录名绝不在候选里', () => {
    expect(cacheDirCandidates().some((p) => p.includes('Dictionaries'))).toBe(false)
    expect(cacheDirCandidates().some((p) => p.includes('Local Storage'))).toBe(false)
  })
})

describe('新鲜度闸门（约定：看活动，不看存在）', () => {
  it('八天没被写过的才进目标；今天的与不存在的都不进', () => {
    const stale = scratch('session/Cache')
    const live = scratch('session/Code Cache')
    makeCache(stale, [['index', 100], ['f1', 200]])
    makeCache(live, [['index', 100]])
    backdate(stale, 8)
    touchDir(live)
    const picked = pickStaleTargets([stale, live, scratch('elsewhere/Cache')], Date.now(), LIVE)
    expect(picked).toEqual([stale])
  })

  it('反向对照：目录自己旧、直接子目录今天被写过 ⇒ 判为活的（这条挡的是档案根哪天翻回 sessionData）', () => {
    const dir = scratch('session/Code Cache')
    makeCache(dir, [['sub/data_0', 300]])
    backdate(dir, 8)
    touchDir(path.join(dir, 'sub'))
    expect(pickStaleTargets([dir], Date.now(), LIVE)).toEqual([])
    expect(fs.existsSync(dir)).toBe(true)
  })

  it('符号链接不当作可删目标（不跟随，不删到 DATA_DIR 外面去）', () => {
    const real = scratch('elsewhere/Cache')
    fs.mkdirSync(path.dirname(real), { recursive: true })
    makeCache(real, [['index', 50]])
    const link = scratch('link/Cache')
    fs.mkdirSync(path.dirname(link), { recursive: true })
    try {
      fs.symlinkSync(real, link, 'dir')
    } catch {
      // Windows 非开发者模式可能没权限：此时这条由"候选路径全部来自常量"兜住
      expect(fs.existsSync(link)).toBe(false)
      return
    }
    backdate(real, 8)
    expect(pickStaleTargets([link], Date.now(), LIVE)).toEqual([])
    expect(fs.existsSync(real)).toBe(true)
  })
})

describe('真删（真临时目录，逐文件）', () => {
  it('释放数等于手工统计、目录消失，同棵树里的词典目录一个字节没被动', async () => {
    const tree = scratch('session')
    // 前面几例在同一棵 scratch 树里留过文件 ⇒ 本例自己先把树清干净，统计才对得上
    fs.rmSync(tree, { recursive: true, force: true })
    const target = path.join(tree, 'Cache')
    const bytes = makeCache(target, [['Cache_Data/data_0', 4096], ['Cache_Data/data_1', 2048], ['index', 512]])
    const dicts = makeCache(path.join(tree, 'Dictionaries'), [['en-US-10-1.bdic', 1234]])
    backdate(target, 8)
    expect(fs.existsSync(path.join(target, 'Cache_Data', 'data_0'))).toBe(true)
    const r = await sweepGivenTargets([target])
    expect(r.freedFiles).toBe(3)
    expect(r.busyFiles).toBe(0)
    expect(r.freedBytes).toBe(bytes)
    expect(fs.existsSync(target)).toBe(false)
    expect(fs.readFileSync(path.join(tree, 'Dictionaries', 'en-US-10-1.bdic')).length).toBe(dicts)
  })

  it('没有遗留可清时返回全零，且不去递归任何东西', async () => {
    fs.rmSync(scratch('session'), { recursive: true, force: true })
    const r = await sweepStaleProfileCaches()
    expect(r).toMatchObject({ freedBytes: 0, freedFiles: 0, busyFiles: 0, targets: [] })
  })

  it('删完再跑一次是幂等的（第二次没有目标）', async () => {
    const dir = scratch('session/Cache')
    makeCache(dir, [['Cache_Data/data_0', 128]])
    backdate(dir, 8)
    const first = await sweepStaleProfileCaches()
    expect(first.freedFiles).toBe(1)
    const second = await sweepStaleProfileCaches()
    expect(second.targets).toEqual([])
    expect(second.freedFiles).toBe(0)
  })
})

describe('安全轨（形状扫描）', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../src/main/steward/stale-cache-sweep.ts'), 'utf-8')
  const indexSrc = fs.readFileSync(path.resolve(__dirname, '../src/main/index.ts'), 'utf-8')

  it('源码里不出现递归强删：rmSync 或 recursive: true 都不许（192 实测那样会抛在半态上）', () => {
    expect(src).not.toContain('rmSync')
    expect(src).not.toContain('recursive: true')
    expect(src).not.toContain('rimraf')
  })

  it('改名暂存与活根排除这两道防线还在（退回原地逐文件删就会重新造出半态）', () => {
    expect(src).toContain('fs.promises.rename')
    expect(src).toContain('isUnder(dir, liveRoot)')
  })

  it('启动调用点零入参：路径只能由常量拼出来，外部输入没有入口', () => {
    expect(indexSrc).toMatch(/sweepStaleProfileCaches\(\)/)
    expect(indexSrc).not.toMatch(/sweepStaleProfileCaches\([^)]/)
    // 用例用的注入版不能出现在启动路径上
    expect(indexSrc).not.toContain('sweepGivenTargets')
  })
})

describe('活根闸门与计数（V4-Iter-194：193 的两条缺陷）', () => {
  it('默认活根取自 app.getPath 的 userData 分支，不是另一个常量', () => {
    expect(liveProfileRoot()).toBe(LIVE)
  })

  it('活根之下那棵即使八天没被写过也不删——闲置不等于遗留', () => {
    const underLive = path.join(LIVE, 'Code Cache')
    makeCache(underLive, [['js/index', 2048]])
    backdate(underLive, 8)
    const legacy = scratch('session/Cache')
    makeCache(legacy, [['Cache_Data/data_0', 512]])
    backdate(legacy, 8)
    expect(pickStaleTargets([underLive, legacy], Date.now(), LIVE)).toEqual([legacy])
    expect(fs.existsSync(underLive)).toBe(true)
  })

  it('活根下没有标记缓存 ⇒ 档案根不是我们以为的那个，一个都不删', () => {
    const legacy = scratch('session/Code Cache')
    makeCache(legacy, [['js/index', 256]])
    backdate(legacy, 8)
    const emptyRoot = scratch('unknown-root')
    fs.mkdirSync(emptyRoot, { recursive: true })
    expect(pickStaleTargets([legacy], Date.now(), emptyRoot)).toEqual([])
    expect(fs.existsSync(legacy)).toBe(true)
  })

  it('先改名再删：原位置不留 .sweep-stale，中途失败的字节不谎报', async () => {
    const dir = scratch('session/Code Cache')
    const staged = dir + '.sweep-stale'
    // 同一棵 session 树被前面几例复用过 ⇒ 本例自己清干净，计数才对得上
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(staged, { recursive: true, force: true })
    makeCache(dir, [['js/a', 1000], ['js/b', 2000], ['js/c', 3000]])

    fs.renameSync(dir, staged)
    const r = await removeTree(staged, async (fp) => {
      if (fp.endsWith(path.join('js', 'b'))) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' })
      await fs.promises.rm(fp)
    })
    expect(r.removedFiles).toBe(2)
    expect(r.removedBytes).toBe(4000)
    expect(r.failed).toBe(1)
    // 删不掉的暂存目录按设计留着（下次启动先收）——本例收尾清掉，别污染下一例
    fs.rmSync(staged, { recursive: true, force: true })
    // 全成功的常规路径：改名后的暂存目录必须被收干净
    const clean = scratch('session/Cache')
    fs.rmSync(clean, { recursive: true, force: true })
    makeCache(clean, [['index', 64]])
    const ok = await sweepGivenTargets([clean])
    expect(ok.freedFiles).toBe(1)
    expect(fs.readdirSync(scratch('session')).some((n) => n.endsWith('.sweep-stale'))).toBe(false)
  })

  it('上一轮没删完的暂存目录会被认出并优先收掉', async () => {
    const staged = scratch('session/Cache.sweep-stale')
    fs.rmSync(scratch('session'), { recursive: true, force: true })
    makeCache(staged, [['Cache_Data/data_0', 700]])
    expect(findStagingLeftovers()).toContain(staged)
    const r = await sweepStaleProfileCaches()
    expect(r.freedBytes).toBe(700)
    expect(fs.existsSync(staged)).toBe(false)
  })
})
