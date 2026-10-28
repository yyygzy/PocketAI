// V4-Iter-353 判据（旧四条之③）：云端备份那张列表的**顺序**自己得站得住。
//
// 为什么这族又回来一次：§327 收了"哪一份是最新"的算法（NaN 参与 `b.mtime - a.mtime` 会折成 +0，
// 整表顺序交给服务器返回顺序），§338 把主进程校验那处也接到同一份派生上；**没收的是排序本身**——
// `listFiles()` 仍用裸减法，而设置页那张列表就是按返回顺序一行行显示的（用户把"从上到下"读成"从新到旧"）。
// 所以这里两头都钉：①顺序函数自己的规矩（判不出的那份沉底、全判不出时不假装知道先后、不改入参），
// ②`listFiles()` 真的走它、且不许再出现裸减法（源码级——那一发要真 WebDAV 服务器，CI 里没有）。
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { sortBackupsNewestFirst } from '../src/shared/backup-latest'

const f = (name: string, mtime: number): { name: string; mtime: number } => ({ name, mtime })
const NAMES = (list: { name: string }[]): string[] => list.map((x) => x.name)

describe('①顺序函数自己的规矩', () => {
  it('全判得出 ⇒ 从新到旧（正向对照：这条不是恒绿的装饰）', () => {
    const got = sortBackupsNewestFirst([f('a', 10), f('b', 30), f('c', 20)])
    expect(NAMES(got)).toEqual(['b', 'c', 'a'])
  })

  it('判不出时间的那份沉底——两种服务器返回顺序算出**同一个**结果', () => {
    // 裸减法下这两条会给出不同答案（NaN 折成"与谁都相等"，顺序交给输入），所以这是能分辨假说的对照
    const nanFirst = sortBackupsNewestFirst([f('未知', NaN), f('新', 30), f('旧', 10)])
    const nanLast = sortBackupsNewestFirst([f('新', 30), f('旧', 10), f('未知', NaN)])
    expect(NAMES(nanFirst)).toEqual(['新', '旧', '未知'])
    expect(NAMES(nanLast)).toEqual(['新', '旧', '未知'])
  })

  it('全都判不出 ⇒ 保持进来那一序（没有先后可判，就不造一个先后）', () => {
    expect(NAMES(sortBackupsNewestFirst([f('x', NaN), f('y', NaN), f('z', NaN)]))).toEqual(['x', 'y', 'z'])
    expect(NAMES(sortBackupsNewestFirst([f('z', NaN), f('y', NaN), f('x', NaN)]))).toEqual(['z', 'y', 'x'])
  })

  it('同一时间戳不互换（V8 稳定排序，别把"并列"演成"随机"）', () => {
    expect(NAMES(sortBackupsNewestFirst([f('先来的', 20), f('后到的', 20), f('更早', 10)]))).toEqual(['先来的', '后到的', '更早'])
  })

  it('不改动传进来的那份数组（调用方手里那份的顺序也是它自己的事实）', () => {
    const input = [f('a', 10), f('b', 30)]
    sortBackupsNewestFirst(input)
    expect(NAMES(input)).toEqual(['a', 'b'])
  })
})

describe('②接线：listFiles 走的就是这一份口径', () => {
  const SRC = readFileSync('src/main/backup/webdav-client.ts', 'utf-8')

  it('那一发确实交给 sortBackupsNewestFirst', () => {
    expect(SRC).toMatch(/return sortBackupsNewestFirst\(\s*\n\s*entries/)
  })

  it('裸减法不许回来：`mtime -` 的比较器一个都不许留（摘回旧写法＝本批白做）', () => {
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
    expect((code.match(/\.sort\(\s*\(?\s*[ab]\s*,\s*[ab]\s*\)?\s*=>\s*[ab]\.mtime\s*-/g) ?? []).length).toBe(0)
    expect(code, 'webdav-client 里不许再有任何按 mtime 的裸减法排序').not.toMatch(/\.sort\([^)]*mtime\s*-[^(]/)
  })
})
