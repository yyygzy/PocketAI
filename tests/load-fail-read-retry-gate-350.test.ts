// V4-Iter-350 闸门：「读不到」那张脸的同级重试键——名单制，两头钉。
//
// 为什么这一族需要按**身份**钉而不是数次数（§348 第 37 条同一条纪律）：
// 形状与 §268／§271 那批留下的先例完全一样（`<LoadFailNotice/>` 之后紧跟一颗同级的 `agent.retryRead`），
// 数"全仓有多少颗重试键"既挡不住有人把键挪进 `role="alert"` 盒子里，也挡不住把 onClick 换成 `() => {}`
// ——那两种写法在 DOM 上看起来一模一样。所以每处钉三件：**testid＋紧跟在那句之后的那颗 button＋onClick 的 initializer 里
// 指的是哪一个具名 loader**；反向再钉一颗：这个新后缀 `-read-retry` 只许出现在名单里，别处为 0。
//
// 名单为什么只有六处（§350 的分诊尺子＝"这一发有没有用户在这屏上命令得动的重读入口"）：
//   · 61 处 `<LoadFailNotice>` 调用点里，先例已给 15 处配过同级键（`-retry` 那一族，本批不动）；
//   · 剩下 46 处分三档——**同屏已有出口**（管家页「重新检测」／MCP 调用日志「刷新」／会话栏「新对话」／
//     技能与知识库那两个"再点一次那一格就重发"的读……）不给，给了就是第二颗同义键；
//     **那一发还没有具名 loader**（挂载 effect 内联 `.then`，17 处：设置页六发、浮窗、首启向导、绘图页、
//     问答与翻译那几发）不给——先抽 loader 再配键，否则键点了等于没点（§347"永不生效的守卫"同族）；
//     **同屏没出口且 loader 已具名**的六处才收，就是下面这份名单。
//   · 另有两处需要跨文件把 loader 递进来（`useProviderData` 的 `load` 没在返回值里、会话栏的重拉者在
//     `useAgentChat` 里）⇒ 本批没做，记在台账候选。
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const R = 'src/renderer/src'
const src = (p: string): string => readFileSync(`${R}/${p}`, 'utf-8')

type Site = { file: string; testid: string; loader: string }
const SITES: Site[] = [
  { file: 'components/RemindersModal.tsx', testid: 'reminders-list-read-retry', loader: 'reload(tab)' },
  { file: 'modules/agent/mcp/McpPanel.tsx', testid: 'mcp-servers-read-retry', loader: 'load()' },
  { file: 'modules/knowledge/KnowledgeModule.tsx', testid: 'kb-list-read-retry', loader: 'load()' },
  { file: 'modules/knowledge/KnowledgeModule.tsx', testid: 'kb-docs-read-retry', loader: 'loadDocs()' },
  { file: 'modules/settings/DataHealthPanel.tsx', testid: 'data-health-read-retry', loader: 'load(true)' },
  { file: 'modules/settings/UsagePanel.tsx', testid: 'usage-summary-read-retry', loader: 'reload' }
]

/** `<LoadFailNotice … />` 之后紧跟一颗带这个 testid 的 button，中间只准隔空白与注释 */
const PAIR = (testid: string): RegExp =>
  new RegExp(`<LoadFailNotice[\\s\\S]{0,200}?/>\\s*(?:/\\*[\\s\\S]{0,220}?\\*/\\s*)?<button\\s+data-testid="${testid}"`, 'm')

const onClickOf = (text: string, testid: string): string => {
  const at = text.indexOf(`data-testid="${testid}"`)
  expect(at, `找不到那颗键 ${testid}`).toBeGreaterThan(-1)
  const m = /onClick=\{([\s\S]{0,120}?)\}/.exec(text.slice(at, at + 700))
  expect(m, `${testid} 的 onClick 没读出来`).not.toBeNull()
  return ((m as unknown as { 1: string })[1] ?? '').trim()
}

describe('①名单内：每处都是"那句在前、那颗键在后"，且 onClick 指的是那个具名 loader', () => {
  for (const s of SITES) {
    it(`${s.file} → ${s.testid}`, () => {
      const text = src(s.file)
      expect(text.match(PAIR(s.testid)), `${s.testid} 没有紧贴在 <LoadFailNotice/> 之后（键必须在那句之后、同一个父块里）`).toBeTruthy()
      const onClick = onClickOf(text, s.testid)
      // 判据读的是 initializer 里的标识符（§346 口径）：`() => {}`、写成别的 loader、换成新造的读都会红
      expect(onClick, `${s.testid} 的 onClick 不再指向 ${s.loader}：${onClick}`).toContain(s.loader)
      // 名字只有一个出处：字典键，不许手抄
      expect(text.slice(text.indexOf(`data-testid="${s.testid}"`)), `${s.testid} 的 label 不是从字典取的`)
        .toMatch(/\{t\('agent\.retryRead'\)\}/)
    })
  }
})

describe('②反向钉：新后缀只许出现在名单里', () => {
  const files = [
    'components/RemindersModal.tsx',
    'modules/agent/mcp/McpPanel.tsx',
    'modules/knowledge/KnowledgeModule.tsx',
    'modules/settings/DataHealthPanel.tsx',
    'modules/settings/UsagePanel.tsx',
    'modules/agent/chat/AgentPanel.tsx',
    'modules/agent/components/SessionRail.tsx',
    'modules/image/ImageModule.tsx',
    'modules/translate/TranslateModule.tsx',
    'modules/wizard/FirstRunWizard.tsx',
    'popup/PopupApp.tsx',
    'modules/chat/ChatConfigBar.tsx'
  ]
  it('`-read-retry` 的总数＝名单数（多了就是给不该有机关的地方造了键）', () => {
    let n = 0
    for (const f of files) n += (src(f).match(/-read-retry/g) ?? []).length
    expect(n).toBe(SITES.length)
  })
  it('名单外的那些文件里一颗都没有（判过"同屏已有出口"与"还没具名 loader"的不许顺手加）', () => {
    const roster = new Set(SITES.map((s) => s.file))
    for (const f of files) {
      if (roster.has(f)) continue
      expect(src(f).match(/-read-retry/g), `${f} 本批不该出现 -read-retry`).toBeNull()
    }
  })
})

describe('③键不许搬进那个 alert 盒子', () => {
  it('LoadFailNotice 本体仍然只渲染那一个 role="alert" 的 div、里面没有 button', () => {
    // 读 AST 之外的最稳妥近似：先摘掉行首注释，否则我自己写在头部的那句 "role=alert" 会把计数撑大（§348 第 33 条）
    const code = src('components/LoadFailNotice.tsx')
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n')
    expect((code.match(/role="alert"/g) ?? []).length, '那个盒子的数量必须是一颗：多处就说不清键在不在里面').toBe(1)
    expect(code, '键必须由调用点摆在盒子外面；组件里出现 button＝§268 那个 textContent 混字的坑回来了').not.toMatch(/<button/)
    // 那句话的出处只有这两条成对键（§230／§345 的口径：同概念两句话就是口径漂移）
    expect((code.match(/'common\.loadFailed(?:Named)?'/g) ?? []).sort()).toEqual(
      ["'common.loadFailed'", "'common.loadFailedNamed'"]
    )
  })
})
