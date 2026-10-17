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
const KNOWN_UNREFERENCED: Array<{ key: string; tier: 'A' | 'B'; zh: string }> = [
  // 160 判完并删了 16 把（都有活键接替，证据在台账 V4-Iter-160），`agent.approval.autoRejectHint` 则接回了弹窗；
  // 下面这 5 把**没找到接替者**——要么对应的提示真的不再出现、要么换了别的呈现方式，属产品判断，所以留在字典里等处置
  { key: 'common.none', tier: 'B', zh: '（无）' },
  { key: 'skill.market.editHint', tier: 'B', zh: '请到左侧技能页编辑该副本' },
  { key: 'terminal.outputTruncated', tier: 'B', zh: '输出过长已截断…' },
  { key: 'mention.kbAttached', tier: 'B', zh: '已引用知识库：{name}' },
  { key: 'mention.kbLimit', tier: 'B', zh: '最多引用 {n} 个知识库' }
]

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
    ).toEqual(KNOWN_UNREFERENCED.map((x) => x.key).sort())
  })

  it('清单不是摆设：每条都仍在实际结果里、且四本字典都还留着这把键', () => {
    expect(KNOWN_UNREFERENCED.length, '清单清空了不等于闸门还在——留一把真的没被引用的键做样本').toBeGreaterThan(3)
    for (const lang of ['zh', 'en', 'ja', 'ko'] as const) {
      const t = fs.readFileSync(path.join(I18N, `${lang}.ts`), 'utf8')
      for (const e of KNOWN_UNREFERENCED) {
        expect(unreferenced, `清单里的 ${e.key} 已被接回引用 ⇒ 该从清单删掉`).toContain(e.key)
        expect(t.includes(`'${e.key}':`), `${lang} 里 ${e.key} 不见了，但清单没同步`).toBe(true)
      }
      expect(t.includes("'wizard.modelTitle':"), `${lang} 还留着 158 误改的那把死键`).toBe(false)
    }
  })

  it('zh 文本对得上清单（防止清单写的是另一把键）', () => {
    for (const e of KNOWN_UNREFERENCED) {
      const line = zhText.split('\n').find((l) => l.trim().startsWith(`'${e.key}':`))
      expect(line, `字典里没有 ${e.key}`).toBeTruthy()
      if (e.zh.length > 20) continue // 长句只记了省略版，不逐字比
      expect(line, `${e.key} 的 zh 文本与清单不符：${line}`).toContain(e.zh)
    }
  })
})
