// V4-Iter-350 闸门：「读不到」那张脸的同级重试键——名单制，两头钉。
//
// 为什么这一族需要按**身份**钉而不是数次数（§348 第 37 条同一条纪律）：
// 形状与 §268／§271 那批留下的先例完全一样（`<LoadFailNotice/>` 之后紧跟一颗同级的 `agent.retryRead`），
// 数"全仓有多少颗重试键"既挡不住有人把键挪进 `role="alert"` 盒子里，也挡不住把 onClick 换成 `() => {}`
// ——那两种写法在 DOM 上看起来一模一样。所以每处钉三件：**testid＋紧跟在那句之后的那颗 button＋onClick 的 initializer 里
// 指的是哪一个具名 loader**；反向再钉一颗：这个新后缀 `-read-retry` 只许出现在名单里，别处为 0。
//
// 名单为什么是这三十五处（§357 又补一颗：对话页服务商那一发以前根本不判信封，修好之后这张脸才存在）（分诊尺子＝"这一发有没有用户在这屏上**命令得动**的重读入口"）：
//   · 现数（§357 重跑同一把尺子 `data/tmp/scope-354.py`）：62 处 `<LoadFailNotice>` 调用点，
//     **50 处旁边已有同级重试键**（＝§354 那版的 31＋§354 收的 8＋§355 的 10＋§357 的 1）、**12 处没有**——
//     那 12 处全部已写过判语：10 处"同屏已有出口"（名单末尾那段）＋本批新判 2 处（`PopupApp` 的模型清单＝同屏那颗「拉模型」
//     就是 `fetchModels`；`PopupApp` 的载荷＝`applyPayload` 会把文本写回输入框，重试是重放有副作用的动作）⇒ **本批之后不再有"没判过的脸"**；
//     27 的构成＝24 颗带字面 testid＋1 颗 testid 走变量（`AssistantEditor.tsx` 那句一键工厂 `listFailLine`
//     ＝上一轮按字面量扫的**漏数**）＋2 处键在但压根没有 testid（`ChatModule` 草稿、首启向导助手）；
//   · 启发式的假阳一处：`ChatModule.tsx` 的消息那一发往后五行撞进**隔壁** `draftUnread` 那块自己的键，
//     其实它没有出口⇒ §352 收了它。窗口判据只能用来出候选，**每处都得回读**；
//   · 剩下 34 处里：§352 收 4 处（那一发的重拉者已具名、且这一支同屏真没出口）；
//     判"同屏已有出口"11 处——`McpForm` 头顶那颗「检测」的 onClick 就是 `loadPyRuntimes`、
//     MCP 调用日志的「刷新」就是 `reloadCallLogs`、`ChatConfigBar` 两发的写者只有 `toggleSection`（再点那一格就重发）、
//     `KbAskPanel` 的「历史」按钮里就 `refreshSessions`、管家页顶部「重新检测」重拉那四发、
//     浮窗「拉模型」那颗就是 `fetchModels`、绘图页"最新那张"的写者在 `handleGenerate` 里（指它＝重跑一次生成＝花额度，那是假出口）；
//   · **本批误判又被回读推翻的一处（写在这里当反面教材）**：我照"state 的直接写者"数出口，
//     看到模型推荐那发的写者只有 `refreshRecommendation`、顶部「重新检测」写的是别处三发 ⇒ 判它没出口并造了键；
//     回读 `load()` 的最后**一行就是 `refreshRecommendation()`**，而 §345 那颗 stale 键正是点「重新检测」演出来的
//     ⇒ 键已撤销。**判"有没有出口"要顺着 loader 的调用链往下看一层，只看 setter 名单会误判**；
//   · §354 收了那 19 处里的**八处**——先抽具名 loader（读写从挂载 effect 体内联 `.then` 提成 `useCallback`，
//     effect 改成只调它；依赖照旧写死 `[]` 的那几处**不能顺手改成 `[t]`**，那会让换语言时多发一发读＋重订一遍事件）
//     再配键：设置页五处（智能标题／路径脚注／WebDAV 配置／浮窗快捷键／更新信息——最后一处的读在父页，
//     以 `onReloadInfo` 递进 props 驱动的 UpdatePanel，形状同 §351 许可证与 §352 加密面板）＋
//     对话页侧栏三处（`useConversationLists` 那一发重拉三份清单⇒ **三句配三颗键**，同 §351 会话栏）；
//   · §355 收的是 §354 留下的那一档"要先抽 loader"的 12 处（与上面第 12 行那个"没有键的 12 处"不是同一批数）：
//     十处抽完 loader 就配键（绘图页三发——预览那颗顺手把 `alive` 闭包换成组件级代次判据、
//     问答／翻译各一发、知识库分片预览一发、向导两发＝同一句话挂两个槽位即 §332 第 32 条那一档、浮窗两发），
//     余两处判"不给"＝上面那两处新判 ⇒ 名单 24→34，这一族不再有"没判过的脸"；
//   · §357 再加第三十五颗：对话页 `ChatModule.loadProviders` 那一发**过去完全不判信封**，失败对象被当数组写进
//     `providers`⇒渲染期 `providers.some(...)` 抛 TypeError⇒根 error boundary 把整个应用换成「界面出错了」。
//     判信封、上一份清单留着、句子与同级键都到位⇒ 这一屏从此也有出口（ChatModule 全仓不挂载⇒这颗**只有闸门看得见**）。
//   · 厚度：§355 那十颗键**每颗都被真挂载按过一次**（`tests/load-fail-read-retry-355.test.tsx` 11 例，
//     含向导两发同屏各点各的、浮窗两句配两颗键互不顶替、预览那发的代次判据）——闸门只保证身份，行为才保证有牙（第 35 条）；
//     **有一档只有闸门看得见**：把标签从 `{t('agent.retryRead')}` 改成手抄中文。用例里的 `RETRY` 就是按字典取的那句，
//     zh 的值正是「重试」⇒ 抄对了行为面比不出差别，只有本闸门读 JSX 里那个 `t(...)` 才咬得住（变异轮 U7 现测：只闸门红）；
//   · 抽 loader 时给 PopupPanel 那个起名 `loadPopupCfg` 而非 `loadCfg`：本闸门的 onClick 判据读的是 initializer 里的
//     **标识符子串**，`loadCfg` 会被隔壁 BackupPanel 的 `reloadCfg` 蒙过去（名字撞车＝判据变瞎），换个不重叠的名比放宽判据便宜。
//   · 判"已有出口"必须**往句子上面看**：`McpForm` 那颗「检测」在句子往上三十行，
//     本批第一稿只回看了十行，差点给它造第二颗同义键。
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
  { file: 'modules/settings/UsagePanel.tsx', testid: 'price-models-read-retry', loader: 'reloadModels' },
  // §352：回读后又找出四处"重拉者已具名、这一支同屏真没出口"（其余"要先抽 loader"的仍然等 §353）
  { file: 'components/OllamaPanel.tsx', testid: 'ollama-status-read-retry', loader: 'refresh' },
  { file: 'modules/chat/ChatModule.tsx', testid: 'chat-messages-read-retry', loader: 'loadMessages' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'backup-schedule-read-retry', loader: 'loadSchedule()' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'encryption-read-retry', loader: 'onChange' },
  // §354：这一档八处原来卡在"那一发没有具名 loader"（读写在挂载 effect 体内联 `.then`）⇒ 本批先抽 loader 再配键。
  // 设置页五处：三处是页内子面板各自挂载那一发、一处是页脚（getPaths）、一处是 props 驱动的 UpdatePanel（父页递 onReloadInfo）；
  // 对话页侧栏三处：`useConversationLists` 那一发重拉三份清单，三句配三颗键＝§351 会话栏先例。
  { file: 'modules/settings/SettingsModule.tsx', testid: 'smart-title-read-retry', loader: 'loadEnabled' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'paths-read-retry', loader: 'loadPaths' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'webdav-cfg-read-retry', loader: 'reloadCfg' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'popup-cfg-read-retry', loader: 'loadPopupCfg' },
  { file: 'modules/settings/SettingsModule.tsx', testid: 'update-info-read-retry', loader: 'onReloadInfo' },
  { file: 'modules/chat/ConversationList.tsx', testid: 'conv-list-read-retry', loader: 'onReloadLists' },
  { file: 'modules/chat/ConversationList.tsx', testid: 'archived-list-read-retry', loader: 'onReloadLists' },
  { file: 'modules/chat/ConversationList.tsx', testid: 'groups-list-read-retry', loader: 'onReloadLists' },
  // §355：这一族收口——剩下那 12 处里的 10 处（另两处判"已有出口／重放有副作用"不给，理由在名单末尾与 roster）
  { file: 'modules/image/ImageModule.tsx', testid: 'image-providers-read-retry', loader: 'loadProviders' },
  { file: 'modules/image/ImageModule.tsx', testid: 'image-gallery-read-retry', loader: 'loadGallery' },
  { file: 'modules/image/ImageModule.tsx', testid: 'image-preview-read-retry', loader: 'loadPreview' },
  { file: 'modules/knowledge/KbAskPanel.tsx', testid: 'kbask-providers-read-retry', loader: 'loadProviders' },
  { file: 'modules/knowledge/KnowledgeModule.tsx', testid: 'kb-chunks-read-retry', loader: 'loadChunks' },
  { file: 'modules/translate/TranslateModule.tsx', testid: 'translate-providers-read-retry', loader: 'loadProviders' },
  { file: 'modules/wizard/FirstRunWizard.tsx', testid: 'wizard-rec-read-retry', loader: 'loadRecommendation' },
  { file: 'modules/wizard/FirstRunWizard.tsx', testid: 'wizard-hardware-read-retry', loader: 'loadHardware' },
  { file: 'popup/PopupApp.tsx', testid: 'popup-providers-read-retry', loader: 'loadProviders' },
  { file: 'popup/PopupApp.tsx', testid: 'popup-assistants-read-retry', loader: 'loadAssistants' },
  // §357：对话页服务商那一读——它过去**根本不判信封**，失败对象被当数组写进 `providers`，渲染期 `providers.some(...)`
  // 抛 TypeError 把整个应用送进根 error boundary（真机现测）。修好之后这张脸才有"读不到"这档，才轮到配出口：
  // 这一屏没有别的键会重发那一发（切回模块的 `reactivate` 只有切走再切回来才发），⇒ 按第三档给键。
  { file: 'modules/chat/ChatModule.tsx', testid: 'chat-providers-read-retry', loader: 'loadProviders' }
]

/** `<LoadFailNotice … />` 之后紧跟一颗带这个 testid 的 button，中间只准隔空白与注释
 *  §355：注释那一档原本只认行注释 `/* … *\/`，可 JSX 子位置写的是 `{/* … *\/}`（带花括号）⇒ 新加的十处里七处被判"没紧贴"。
 *  与其为了过闸门把注释挪走（那是让判据迁就写法），把花括号这一形也认下来——预算不变（仍是 220 字符内的一条注释）*/
const PAIR = (testid: string): RegExp =>
  new RegExp(`<LoadFailNotice[\\s\\S]{0,200}?/>\\s*(?:\\{?/\\*[\\s\\S]{0,220}?\\*/\\}?\\s*)?<button\\s+data-testid="${testid}"`, 'm')

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
      // 名字只有一个出处：字典键，不许手抄。
      // 切片必须**止于那颗 button 自己的 </button>**——早先整片切到文件末尾，于是 M9 那种"把这一颗的标签手抄成中文"
      // 会被后面另一颗键的字典取值蒙过去（判据一改，整轮变异重跑）
      const at2 = text.indexOf(`data-testid="${s.testid}"`)
      const close = text.indexOf('</button>', at2)
      expect(close, `${s.testid} 那颗 button 没有收尾`).toBeGreaterThan(at2)
      expect(text.slice(at2, close), `${s.testid} 的 label 不是从字典取的`).toMatch(/\{t\('agent\.retryRead'\)\}/)
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
