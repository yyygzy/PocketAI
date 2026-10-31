// V4-Iter-377（候选 #3＋#7）：管家屏两处「把不知道／没跑成画成正常」的源码级闸门。
//
// 两簇同一形状——失败被折成一个"看着正常"的值：
//   #3 `src/main/steward/hardware.ts`：介质没探测出来时 `info.type = 'ssd'`（win32 的 `raw.dtype === 3` 那一支、
//      darwin 的非可移除那一支）。机械盘被画成 SSD，管家屏／诊断报告／首启向导三处跟着说谎。
//   #7 `src/main/health/health.ts`：`try { db.exec('VACUUM') } catch { /* ignore */ }` ＋ `Math.max(0, before-after)`，
//      VACUUM 抛了也回 0 ⇒ 绿色成功句「回收 0」。"没跑成"与"跑过了、没东西可回收"塌成同一个数字。
//
// 本文件钉的是**结构**（推断那一支不许回到调用点、catch 不许再空、界面必须两张脸、四语必须两句不同）；
// 真行为在两份额外的文件里：`hardware-disk-type-377.test.ts`（纯函数）＋`renderer-steward-vacuum-377.test.tsx`（真挂载两张脸）。
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { zh } from '../src/renderer/src/i18n/zh'
import { en } from '../src/renderer/src/i18n/en'
import { ja } from '../src/renderer/src/i18n/ja'
import { ko } from '../src/renderer/src/i18n/ko'

const read = (rel: string): string =>
  fs.readFileSync(path.resolve(__dirname, '..', 'src', rel), 'utf-8').replace(/\r\n/g, '\n')

const HW = read('main/steward/hardware.ts')
const HEALTH = read('main/health/health.ts')
const PANEL = read('renderer/src/modules/steward/StewardModule.tsx')
const DICTS: Record<string, Record<string, string>> = { zh, en, ja, ko }

/** 取 `function <name>(...) { ... }` 的函数体（按花括号配对，注释里的花括号不算——先剥注释） */
const stripComments = (src: string): string =>
  src
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n')

/** 取函数体：两种写法都认——`function name(...)` 与类方法 `name(...): T {`（health.ts 的两个方法就是后者） */
const functionBody = (src: string, name: string): string => {
  const clean = stripComments(src)
  const sig = clean.search(new RegExp(`function ${name}\\(|^[ \\t]+${name}\\(`, 'm'))
  if (sig < 0) throw new Error(`找不到 ${name}（读法失效，不是代码失效）`)
  const open = clean.indexOf('{', clean.indexOf(')', sig))
  let depth = 0
  for (let i = open; i < clean.length; i++) {
    if (clean[i] === '{') depth++
    else if (clean[i] === '}') {
      depth--
      if (depth === 0) return clean.slice(open + 1, i)
    }
  }
  throw new Error(`${name} 花括号没配平`)
}

// ───── 读法自证：这套读法确实读得到东西，且认得出改前那一形 ─────

describe('读法自证（闸门自己的牙）', () => {
  it('functionBody 取到 getDiskWin32 / getDisk 的体内文本', () => {
    const win32 = functionBody(HW, 'getDiskWin32')
    expect(win32).toContain('parseJsonSafe<RawDisk>')
    expect(functionBody(HW, 'getDisk')).toContain("process.platform === 'darwin'")
  })

  it('夹具＝改前的推断那一支，读法必须认出来（不是对着空文本放行）', () => {
    const before = '  } else if (raw.dtype === 3) {\n    info.type = \'ssd\'\n  }\n'
    expect(/else if \((?:raw\.dtype|input\.dtype) === 3\)[\s\S]{0,120}?=\s*'ssd'/.test(stripComments(before))).toBe(true)
    const beforeDarwin = "      info.type = info.removable ? 'usb' : 'ssd'\n"
    expect(/:\s*'ssd'/.test(beforeDarwin)).toBe(true)
  })

  it('夹具＝改前的空 catch，读法必须认出来', () => {
    const before = "    try { db.exec('VACUUM') } catch { /* ignore */ }\n"
    expect(/catch\s*\{[^}]*\}/.exec(before)?.[0]).toMatch(/catch\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/)
  })
})

// ───── #3：介质推断 ─────

describe('#3 hardware.ts：推断支归零 ＋ 结论出自纯函数', () => {
  it('getDiskWin32 体内不许再有「dtype===3 ⇒ ssd」那一支，也不许有裸的 `= \'ssd\'` 赋值', () => {
    const body = functionBody(HW, 'getDiskWin32')
    expect(body, '改前那一支回来了').not.toMatch(
      /else if \((?:raw\.dtype|input\.dtype) === 3\)[\s\S]{0,120}?=\s*'ssd'/
    )
    expect(body, 'SSD 只能由 deriveDiskTypeWin32 依实测介质给出，不许在调用点直接写死').not.toMatch(/=\s*'ssd'/)
  })

  it("getDisk 的 darwin 支不许再写 removable ? 'usb' : 'ssd'，结论走 deriveDiskTypeDarwin", () => {
    const body = functionBody(HW, 'getDisk')
    expect(body, 'darwin 那支把"固定卷"又当 SSD 了').not.toMatch(/:\s*'ssd'/)
    expect(body).toContain('deriveDiskTypeDarwin(')
  })

  it('两个 derive 函数是导出的纯决策点，且 unknown 是它们的兜底档（不导出＝行为用例只能靠桩）', () => {
    expect(/export function deriveDiskTypeWin32\(/.test(HW), 'win32 决策点没独立出来').toBe(true)
    expect(/export function deriveDiskTypeDarwin\(/.test(HW), 'darwin 决策点没独立出来').toBe(true)
    expect(functionBody(HW, 'deriveDiskTypeWin32').trim()).toMatch(/return\s*'unknown'$/)
    expect(functionBody(HW, 'deriveDiskTypeDarwin')).toMatch(/\?\s*'usb'\s*:\s*'unknown'/)
  })

  it('win32 的 ssd／hdd 两档必须绑在 mediumType 的条件上（绑在别处＝那条证据链断了，闸门第 34 条）', () => {
    const body = functionBody(HW, 'deriveDiskTypeWin32')
    for (const want of ['SSD', 'HDD']) {
      const re = new RegExp(`if \\(input\\.mediumType === '${want}'\\) return\\s*'${want.toLowerCase()}'`)
      expect(body, `${want} 那档不再由介质决定`).toMatch(re)
    }
  })

  it('removable 与 type 同源（同一个"是不是可移动"判据不许在两处各写一遍）', () => {
    const body = functionBody(HW, 'getDiskWin32')
    expect(body).toMatch(/info\.removable = info\.type === 'usb'/)
    expect(body, '又出现了平行的 dtype===2||USB 判据').not.toMatch(/dtype === 2/)
  })
})

// ───── #7：VACUUM ─────

describe('#7 health.ts：VACUUM 抛错不许再被咽', () => {
  it('两处 VACUUM 的 catch 体都必须记账（改前是空的 /* ignore */）', () => {
    const blocks = HEALTH.match(/try\s*\{\s*db\.exec\('VACUUM'\)\s*\}\s*catch\s*\{[\s\S]*?\}/g) ?? []
    expect(blocks.length, 'VACUUM 的 try/catch 数不对（新增调用点要一起判）').toBe(2)
    for (const b of blocks) {
      const body = b.slice(b.indexOf('catch') + 5).trim()
      expect(b, `空 catch 回来了：${b}`).not.toMatch(/catch\s*\{\s*(\/\*[^*]*\*\/\s*)?\}/)
      expect(body, `catch 里没记账：${b}`).toMatch(/vacuumFailed\s*=\s*true/)
    }
  })

  it('两个方法的返回值都带出 vacuumFailed（只 log 不带回＝界面演不出那张脸）', () => {
    const cleanup = functionBody(HEALTH, 'cleanup')
    const vacuum = functionBody(HEALTH, 'vacuum')
    expect(cleanup).toMatch(/return\s*\{[\s\S]*?vacuumFailed[\s\S]*?\}/)
    expect(vacuum).toMatch(/return\s*\{[\s\S]*?vacuumFailed[\s\S]*?\}/)
  })

  it('cleanup 不许因为 VACUUM 坏了就把删除结果一起吞掉（部分成功要说两句、不是整发失败）', () => {
    const cleanup = functionBody(HEALTH, 'cleanup')
    expect(cleanup).toMatch(/removedOrphanMessages:\s*rmMsg/)
    expect(cleanup).toMatch(/removedOrphanChunks:\s*rmChunk/)
    expect(cleanup, '兜底成负数那种写法回来了').toMatch(/Math\.max\(0, beforeBytes - afterBytes\)/)
  })

  it('契约两头钉：类型里有真空字段，preload 的手签名跟着换了形状', () => {
    const types = read('shared/types.ts')
    expect(types).toMatch(/export interface CleanupResult \{[\s\S]*?vacuumFailed: boolean[\s\S]*?\}/)
    expect(types).toMatch(/export interface VacuumOutcome \{[\s\S]*?vacuumedBytes: number[\s\S]*?vacuumFailed: boolean[\s\S]*?\}/)
    const preload = read('preload/index.ts')
    expect(preload).toMatch(/runVacuum: \(\): Promise<VacuumOutcome>/)
    expect(preload, '还写着 Promise<number>＝把对象当数字用').not.toMatch(/runVacuum: \(\): Promise<number>/)
  })
})

// ───── #7 的界面两张脸 ─────

describe('#7 StewardModule：两张脸各按状态取，同一时刻只一句', () => {
  it('成功态存的不是裸数字（裸数字分不出"没跑成"与"没东西可回收"）', () => {
    expect(PANEL).toMatch(/useState<VacuumOutcome \| null>\(null\)/)
    expect(PANEL, '旧的裸数字那一份 state 回来了').not.toMatch(/const \[vacuumBytes, setVacuumBytes\]/)
  })

  it('两块结果面板都是二选一的条件式（不是一句成功文案＋一句常驻说明）', () => {
    expect(PANEL).toMatch(/cleanupResult\.vacuumFailed\s?\n?\s*\?[\s\S]{0,400}:[\s\S]{0,120}steward\.cleanupResult/)
    expect(PANEL).toMatch(/vacuumResult\.vacuumFailed\s?\n?\s*\?[\s\S]{0,400}:[\s\S]{0,120}steward\.vacuumResult/)
  })

  it('警示句走警示色、成功句走成功色（把失败画成绿色＝#7 的原病）', () => {
    const boxes = PANEL.match(/mt-2 px-2 py-1\.5 rounded text-\[11px\][\s\S]{0,300}/g) ?? []
    expect(boxes.length, '两块面板的容器式样数不对').toBe(2)
    for (const box of boxes) {
      expect(box).toMatch(/vacuumFailed/)
      expect(box).toMatch(/--color-warning/)
      expect(box).toMatch(/--color-success/)
    }
  })

  it('界面两句都从字典取，TSX 里不许硬写中文', () => {
    expect(PANEL).toContain("t('steward.cleanupVacuumFailed'")
    expect(PANEL).toContain("t('steward.vacuumFailed'")
    const jsx = PANEL.match(/steward\.cleanupResult[\s\S]{0,200}/)?.[0] ?? ''
    expect(jsx, '结果句里夹了硬写中文').not.toMatch(/['"`][^'"`\n]*[一-龥][^'"`\n]*['"`]/)
  })
})

// ───── 四语 ─────

describe('四语：两句都在、占位符对、与成功句不共用值', () => {
  const FAILED_PAIR: Array<[string, string[]]> = [
    ['steward.cleanupVacuumFailed', ['m', 'c']],
    ['steward.vacuumFailed', []]
  ]

  for (const [key, params] of FAILED_PAIR) {
    it(`${key} 四语齐全`, () => {
      for (const lang of Object.keys(DICTS)) {
        expect(DICTS[lang]?.[key], `${lang} 缺键`).toBeTruthy()
      }
    })

    it(`${key} 的占位符不多不少（i18n 插值族：填了不存在的名字＝屏上留 {x}）`, () => {
      for (const [lang, dict] of Object.entries(DICTS)) {
        const found = [...(dict[key] ?? '').matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
        expect(found.join(','), `${lang} 的占位符对不上`).toBe([...params].sort().join(','))
      }
    })
  }

  it('两句是两句：警示句与对应的成功句逐字不同（共用一句＝把失败说成成功）', () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      expect(dict['steward.vacuumFailed'], `${lang} 两句同值`).not.toBe(dict['steward.vacuumResult'])
      expect(dict['steward.cleanupVacuumFailed'], `${lang} 两句同值`).not.toBe(dict['steward.cleanupResult'])
      expect(dict['steward.vacuumFailed']).not.toBe(dict['steward.cleanupVacuumFailed'])
    }
  })

  it('成功句一个都没被删掉（两张脸是二选一，不是只留失败那一句）', () => {
    for (const [lang, dict] of Object.entries(DICTS)) {
      expect(dict['steward.cleanupResult'], `${lang} 成功句没了`).toBeTruthy()
      expect(dict['steward.vacuumResult'], `${lang} 成功句没了`).toBeTruthy()
    }
  })
})
