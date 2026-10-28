// V4-Iter-350 闸门：「读不到」那张脸的同级重试键——名单制，两头钉。
//
// 为什么这一族需要按**身份**钉而不是数次数（§348 第 37 条同一条纪律）：
// 形状与 §268／§271 那批留下的先例完全一样（`<LoadFailNotice/>` 之后紧跟一颗同级的 `agent.retryRead`），
// 数"全仓有多少颗重试键"既挡不住有人把键挪进 `role="alert"` 盒子里，也挡不住把 onClick 换成 `() => {}`
// ——那两种写法在 DOM 上看起来一模一样。所以每处钉三件：**testid＋紧跟在那句之后的那颗 button＋onClick 的 initializer 里
// 指的是哪一个具名 loader**；反向再钉一颗：这个新后缀 `-read-retry` 只许出现在名单里，别处为 0。
//
// 名单为什么是这十二处（分诊尺子＝"这一发有没有用户在这屏上**命令得动**的重读入口"）：
//   · 现数（§351 之后）：61 处 `<LoadFailNotice>` 调用点，其中 27 处旁边（14 行内）已有同级 `agent.retryRead` 键——
//     15 处是 §268／§271 的先例（本批不动），12 处是 §350（六处）＋§351（六处）收的，就是下面这份名单；
//   · 34 处旁边没有：把窗口放宽到 40 行还有 5 处其实看得到键（ChatView 与浮窗那几发），
//     那 5 处本批**没逐处回读⇒不写判语**，只登记为启发式盲区；
//   · 剩下 29 处里已回读判过的：11 处"同屏已有别的出口"（管家页「重新检测」／MCP 调用日志「刷新」／
//     会话栏「新对话」／`ChatConfigBar` 与 `KbAskPanel` 那种"再点一次那一格就重发"／`McpForm`「检测」）⇒ 不给；
//   · 其余主要卡在**那一发没有具名 loader**（读写在挂载 effect 体内联 `.then` 里：设置页几发、绘图页四处、
//     首启向导两处、问答一发、翻译一发、分片预览一发……）⇒ 先抽 loader 再配键，否则键点了等于没点
//     （§347"永不生效的守卫"同族）——这是 §352 的账，名单见台账第一百一十一次末尾。
//   · §351 收的六处里两颗是"重拉在别的文件里、要递进来"（AgentPanel 那两发要用 `useProviderData` 新返回的 `load`；
//     会话栏那两发要用父级透下来的 `onReloadLists`），另两颗是 §350 分诊时**漏数**的——许可证那张脸的 `onChange`
//     与定价表那张脸的 `reloadModels` 当时就在作用域里，判成"要先抽 loader"是错的。
import { readdirSync, readFileSync } from 'node:fs'
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
  { file: 'modules/settings/UsagePanel.tsx', testid: 'usage-summary-read-retry', loader: 'reload' },
  // §351：第二档那两处（那一发的重拉在别的文件里、要递进来），另加两处 §350 漏数的事实上已有具名 loader 的脸
  { file: 'modules/agent/chat/AgentPanel.tsx', testid: 'agent-providers-read-retry', loader: 'load()' },
  { file: 'modules/agent/chat/AgentPanel.tsx', testid: 'agent-assistants-read-retry', loader: 'load()' },
  { file: 'modules/agent/components/SessionRail.tsx', testid: 'session-rail-active-read-retry', loader: 'onReloadLists' },
  { file: 'modules/agent/components/SessionRail.tsx', testid: 'session-rail-archived-read-retry', loader: 'onReloadLists' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'license-read-retry', loader: 'onChange' },
  { file: 'modules/settings/UsagePanel.tsx', testid: 'price-models-read-retry', loader: 'reloadModels' }
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

describe('②反向钉：这个新后缀只许出现在名单里（全仓扫，不靠手挑文件清单）', () => {
  const tsx: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.tsx')) tsx.push(p)
    }
  }
  walk(R)
  const found = new Map<string, number>()
  for (const p of tsx) {
    const n = (readFileSync(p, 'utf-8').match(/-read-retry/g) ?? []).length
    if (n > 0) found.set(p.slice(`${R}/`.length), n)
  }
  const want = new Map<string, number>()
  for (const s of SITES) want.set(s.file, (want.get(s.file) ?? 0) + 1)

  it('总数＝名单数（多了就是给不该有机关的地方造了键）', () => {
    let n = 0
    for (const v of found.values()) n += v
    expect(n).toBe(SITES.length)
  })
  it('出现的文件与每文件的颗数，逐一对齐名单', () => {
    expect([...found.entries()].sort()).toEqual([...want.entries()].sort())
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
