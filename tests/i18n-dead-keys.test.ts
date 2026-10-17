// 字典里不许有"没人引用的键"（V4-Iter-159）
//
// 撞出它的过程不体面，所以写长一点：158 我把 `wizard.modelTitle` 的 ja 从「推奨モデル階層」改成「推奨モデルのクラス」，
// 还在验收项 B94 里让用户"去首启向导看那一格标题"。**那把键没有任何引用**——它只在四本字典里，组件从不取它。
// 于是"改了一个不渲染的串"和"指一条不存在的路"同时发生，而全套 CI 是绿的。
// 原因很具体：`i18n-parity` 只保证四本字典**键集合一致**，管不到"有没有人用这把键"——漏译与死键是正交的失效面。
//
// 判"活"的三条途径（都对照源码实况校准过，见下面第一条用例的正/反向对照）：
//  ① 字面引用：源码里出现 `'a.b.c'` 或 `"a.b.c"`（不必是 t() 直接调用，常量表里的键名也算）；
//  ② 动态族：源码里出现以该串开头的模板/拼接前缀——`` `a.b.${x}` ``、`` `a.b${x}` ``（如 `ui.font${size}`）、`'a.b.' + x`；
//  ③ 前缀常量：形如 `xxx: 'a.b.'` 的前缀表（`MODEL_REC_PREFIX` 那一族就靠它免检）。
//
// ⚠️ 这是一张**下限闸门**，不是"绝无死键"的证明：族豁免按前缀粗匹配，所以写过 `t(\`chat.${x}\`)` 之后
// 整个 `chat.*` 族都免检（`chat.export`/`chat.exportImage` 就是这样被放过的，我核对过它们确实没人用）。
// 之所以接受这个不完美：误报会把闸门关掉（154 的 M6 已经教过一次），而"新增一把没人用的键就红"这个价值是确定的。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const I18N = path.join(ROOT, 'src', 'renderer', 'src', 'i18n')

/**
 * 当前未被引用的键（159 逐把核对过：源码里没有字面引用、也不落在任何动态族里）。
 * tier 只是处置参考，CI 不做区别对待：
 *  A = 大概率改名/换写法遗留（同族里有活兄弟键，功能仍在，只是文案换名了）
 *  B = 需要人确认"这块提示是不是真的不再出现"（如向导的安全提示、@ 提及的上限提示）
 * `wizard.modelTitle` 不在表里——它就是 158 我误改那把，本批已从四本字典删除。
 */
// 160 把 159 普查出的 22 把逐条判完，清单因此清空：
//  · 16 把有活键接替 ⇒ 删（`wizard.noRecoveryHint`→`wizard.encDoneHint`、`usage.requestCount`→`usage.requests`、
//    `dh.integrity.*` 三把是改版后去掉节标题而数据仍显示、`ms.*` 五把因对照入口收纳成图标…证据逐条在台账 V4-Iter-160）；
//  · `agent.approval.autoRejectHint` 与 `terminal.outputTruncated` 不是遗留而是**提示缺失** ⇒ 接回（弹窗 / 终端）；
//  · 剩下 4 把（`common.none`、`skill.market.editHint`、`mention.kbAttached`、`mention.kbLimit`）经 git 考古是
//    "从未接线"或"所指的按钮已在 96e4fed 被移除" ⇒ 删。
// **空清单不等于闸门失效**：第一条用例里"一把假键必须被判死"的负面对照守着扫描器本身，
// 下面 DISPOSED 那条守着"删掉的键不许悄悄回来"。
const KNOWN_UNREFERENCED: string[] = []

/** 159→160 期间处置掉的键：字典里再出现它们 = 有人绕过了判定（要么接回引用，要么彻底别留） */
const DISPOSED = [
  'wizard.modelTitle', 'common.none', 'skill.market.editHint', 'mention.kbAttached', 'mention.kbLimit',
  'ms.single', 'ms.provider', 'ms.model', 'ms.modelId', 'ms.addCompare', 'am.deleteBtn', 'usage.requestCount',
  'ollama.running', 'dh.integrity.brokenDocs', 'dh.integrity.duplicates', 'dh.integrity.providerIssues',
  'wizard.installed', 'wizard.securityTitle', 'wizard.securitySubtitle', 'wizard.noRecoveryHint', 'wizard.gotoSettings'
]

/**
 * 已知盲区：主断言扫不到它们（源码里有 `t(`chat.${x}`)` 这类拼法 ⇒ 整族免检），但手工核对过确实没人引用。
 * 单独钉一条"至今无字面引用"，谁接回去了就得把这条挪走——注释不能代替事实。
 */
const KNOWN_BLIND_SPOT = ['chat.export', 'chat.exportImage']

function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) {
      if (p === I18N) continue // 字典自己不算自己的引用源
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const files = walk(path.join(ROOT, 'src'))
const blob = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
const zhText = fs.readFileSync(path.join(I18N, 'zh.ts'), 'utf8')
const dictKeys = [...zhText.matchAll(/^ {2}'([^']+)':/gm)].map((m) => m[1] ?? '')

/** 动态族前缀：模板串 `` `a.b${x}` ``、拼接 `'a.b.' + x`、前缀常量 `xxx: 'a.b.'` */
const families = new Set<string>()
const SHAPE = /^[a-z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]*)*\.?$/
const collect = (s: string) => {
  if (s.includes('.') && SHAPE.test(s)) families.add(s)
}
for (const m of blob.matchAll(/`([^`\n$]*)\$\{/g)) collect(m[1] ?? '')
for (const m of blob.matchAll(/'([^'\n]*)'\s*\+/g)) collect(m[1] ?? '')
for (const m of blob.matchAll(/:\s*'([a-z][a-zA-Z0-9_.]*\.)'/g)) collect(m[1] ?? '')

function isLive(key: string): boolean {
  if (blob.includes(`'${key}'`) || blob.includes(`"${key}"`)) return true
  for (const f of families) if (key.startsWith(f)) return true
  return false
}

const unreferenced = dictKeys.filter((k) => !isLive(k))

describe('字典键必须有人引用', () => {
  it('扫描器自己先过正/反向对照（不是一眼看上去能跑）', () => {
    expect(files.length, 'src 下只扫到这些文件，遍历写坏了').toBeGreaterThan(250)
    expect(dictKeys.length, 'zh 解析出的键数不像话').toBeGreaterThan(1900)
    expect(families.size, '一条动态拼键都没抓到 ⇒ 族豁免形同虚设').toBeGreaterThan(20)
    // 正向：这些都在界面上真的出现
    for (const k of ['wizard.next', 'steward.modelRec', 'ollama.title', 'judgement.reason.measured-bucket', 'agent.approval.reason.GENERIC', 'modelRec.tier.entry', 'ui.fontSmall', 'usage.days7']) {
      expect(isLive(k), `${k} 明明有人用，却被判成死键 ⇒ 扫描器有问题`).toBe(true)
    }
    // 反向：随手写一把不存在于源码的键，必须被判死
    expect(isLive('wizard.modelTitle'), '158 那把死键应当已删除且判死').toBe(false)
    expect(isLive('definitely.nobodyUsesThisKey')).toBe(false)
  })

  it('未被引用的键恰好等于这张显式清单（新增一把红、少一把也红）', () => {
    expect(
      [...unreferenced].sort(),
      `实际未引用：${unreferenced.join(', ')}`
    ).toEqual([...KNOWN_UNREFERENCED].sort())
  })

  it('处置过的键不许悄悄回到字典（回来只有两种正当方式：接回引用，或从 DISPOSED 里删名并说明理由）', () => {
    expect(DISPOSED.length).toBeGreaterThanOrEqual(20)
    for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
      const dict = fs.readFileSync(path.join(I18N, `${lang}.ts`), 'utf8')
      for (const k of DISPOSED) {
        const back = dict.includes(`'${k}':`)
        const wired = blob.includes(`'${k}'`)
        expect(back && !wired, `${lang} 把 ${k} 加回了字典却没接任何引用 ⇒ 绕过了 160 的判定`).toBe(false)
      }
    }
  })

  it('盲区名单：这些键至今仍无字面引用（接回去了就把它从名单里挪走，注释不算事实）', () => {
    expect(KNOWN_BLIND_SPOT.length).toBeGreaterThan(0)
    for (const k of KNOWN_BLIND_SPOT) {
      expect(dictKeys, `${k} 已从字典删除 => 这条盲区记录该一并删掉`).toContain(k)
      expect(blob.includes(`'${k}'`), `${k} 已被接回引用 => 该归主断言管，不再算盲区`).toBe(false)
    }
  })
})
