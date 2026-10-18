// V4-Iter-216：设置／技能／沙箱／图片面 14 个 await 点。
// 共同形状：safeHandle 的失败是 resolve 的 `{ok:false}`，被当成"这次做成了的凭据"用 ⇒
// 绿色提示逐字说「已清理 undefined 条孤儿向量、…」「已创建并打开预览」「✓ 已复制」「✓ 已存入沙箱」「已创建可编辑副本」，而库/剪贴板/磁盘什么都没变；
// 有的还会关掉表单、清空用户输入、把 disabled 永久打在按钮上。
// 证据两层：① 真挂载行为用例（HtmlBlockActions 一对成功／失败对照）；② 14 点形状闸门 ＋ failAction 助手本体检查。
// DataHealthPanel／SettingsModule／StewardModule／OllamaPanel／两个技能面／SandboxModule／AttachmentGrid 的
// 行为面只有闸门覆盖（真挂载要拉起整个设置页/管家页/灯箱，成本不值）——这点如实写进台账。
// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { mountWithProviders, stubPocketai } from './helpers/renderer'
import { HtmlBlockActions } from '../src/renderer/src/modules/agent/components/HtmlBlockActions'
import { zh } from '../src/renderer/src/i18n/zh'

const ZH = zh as unknown as Record<string, string>
/** 界面文案一律取字典（拼错 key 就得到 undefined，用例找不到元素即红） */
const L = (key: string): string => ZH[key]!
const readRaw = (rel: string): Buffer => fs.readFileSync(path.resolve(__dirname, rel))

/** 剥掉行尾 `//`：按引号状态走，`https://` 不算注释。
 *  为什么要剥——闸门是"区域里出现判据文本"，同一行内的 `x = await f()  // if (hasIpcFailed(x)) …` 会被读成已判，
 *  而那其实是死代码。本批写 OllamaPanel 时插入的行尾是孤立 CR（git 把文件判成 binary、按 \n 切行就并成一行），
 *  正是这个形状，闸门当时真的假绿了（见 §216）。 */
const stripTrailingComment = (line: string): string => {
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = ''
      continue
    }
    if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '/' && line[i + 1] === '/') return line.slice(0, i)
  }
  return line
}

const readCode = (rel: string): string =>
  readRaw(rel)
    .toString('utf-8')
    .split('\n')
    .map(stripTrailingComment)
    .filter((l) => l.trim() !== '')
    .join('\n')

/** §212 表里"设置／技能／沙箱／图片"这一档的 14 个点位：[文件, await 锚点, 成功态锚点] */
const SITES: Array<[string, string, string]> = [
  ['../src/renderer/src/modules/settings/DataHealthPanel.tsx', 'cleanKbOrphans()', "return t('dh.integrity.cleanDone'"],
  ['../src/renderer/src/modules/settings/DataHealthPanel.tsx', 'reindexKbDocs(', "return t('dh.integrity.reindexDone'"],
  ['../src/renderer/src/modules/settings/DataHealthPanel.tsx', 'deduplicateKbDocs(', "return t('dh.integrity.dedupDone'"],
  ['../src/renderer/src/modules/settings/SettingsModule.tsx', 'disableRecoveryKey()', "t('enc.recoveryRemoved')"],
  ['../src/renderer/src/modules/settings/SettingsModule.tsx', "setUiPrefs({ customCss: '' })", "setCss('')"],
  ['../src/renderer/src/modules/steward/StewardModule.tsx', 'runVacuum()', 'setVacuumBytes(bytes)'],
  ['../src/renderer/src/modules/steward/StewardModule.tsx', 'setVacuumBytes(bytes)\n      const report = await window.pocketai.getHealthReport()', 'setHealth(report)'],
  ['../src/renderer/src/components/OllamaPanel.tsx', 'installOllama()', 'setStatus(finalStatus)'],
  ['../src/renderer/src/modules/skills/SkillModule.tsx', 'const saved = await window.pocketai.saveSkill({', 'onSaved(saved)'],
  ['../src/renderer/src/modules/skills/SkillMarket.tsx', 'const copy = await window.pocketai.saveSkill({', "flash(true, t('skill.market.duplicated'"],
  ['../src/renderer/src/modules/sandbox/SandboxModule.tsx', 'createSandboxFile(newName, newHtml)', "setNewName('')"],
  ['../src/renderer/src/modules/agent/components/HtmlBlockActions.tsx', "createSandboxFile(t('sandbox.agentDefaultName'), htmlBlock)", 'setSavedToSandbox(true)'],
  ['../src/renderer/src/modules/agent/components/HtmlBlockActions.tsx', 'createSandboxFile(appName, htmlBlock, {', 'setInstallingApp(false)'],
  ['../src/renderer/src/components/AttachmentGrid.tsx', 'writeImageClipboard(src)', 'setCopied(true)']
]
/** 文件名单由点位表导出：往表里加文件忘了加行（或反之）就红，不留两份会漂移的清单 */
const FILES = [...new Set(SITES.map((s) => s[0]))]

describe('① 真挂载行为：「▶ 在沙箱运行」失败不再把按钮永久打勾', () => {
  it('createSandboxFile 返回 {ok:false} ⇒ 按钮仍是「▶ 在沙箱运行」且可再点，toast 逐字给原因', async () => {
    stubPocketai({
      createSandboxFile: () => ({ ok: false, error: '沙箱目录写入失败' }),
      requestSandboxOpenApps: () => undefined
    })
    mountWithProviders(<HtmlBlockActions htmlBlock="<p>hi</p>" />)
    const btn = screen.getByRole('button', { name: new RegExp(L('sandbox.runInSandbox')) })
    fireEvent.click(btn)
    await waitFor(() =>
      expect(screen.queryAllByRole('status').map((e) => e.textContent).join('|')).toContain('沙箱目录写入失败')
    )
    expect((screen.getByRole('button', { name: new RegExp(L('sandbox.runInSandbox')) }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('反向对照：保存成功 ⇒ 按钮才变成打勾的「✓ 已存入沙箱」并 disabled', async () => {
    stubPocketai({
      createSandboxFile: () => ({ id: 'sb1', name: 'x' }),
      requestSandboxOpenApps: () => undefined
    })
    mountWithProviders(<HtmlBlockActions htmlBlock="<p>hi</p>" />)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(L('sandbox.runInSandbox')) }))
    const done = await screen.findByRole('button', { name: new RegExp(L('sandbox.savedToSandbox')) })
    expect((done as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryAllByRole('status').map((e) => e.textContent).join('|')).toBe('')
  })
})

describe('② 形状闸门：14 个点逐个核对「判失败」排在「写成功态」之前', () => {
  it('正好 14 个点位、9 个文件（§212 表里这一档的全集，少一处就是闸门在空转）', () => {
    expect(SITES.length).toBe(14)
    expect(FILES.length).toBe(9)
  })

  for (const [rel, from, until] of SITES) {
    it(`${rel.split('/').pop()} — ${from.slice(0, 32)}… 之后、成功态之前必须判失败`, () => {
      const src = readCode(rel)
      const a = src.indexOf(from)
      expect(a, `锚点丢了：${from}`).toBeGreaterThanOrEqual(0)
      const b = src.indexOf(until, a)
      expect(b, `成功态锚点丢了：${until}`).toBeGreaterThan(a)
      const region = src.slice(a, b)
      expect(region, `${from} 的失败没判`).toMatch(/hasIpcFailed|isIpcFail|'ok' in |failAction\(|!r\.ok|\br\.ok\b/)
      expect(region, `${from} 判了却没守住成功态`).toMatch(/\breturn\b|\belse\b/)
      expect(region, `${from} 判了失败但没有反馈面`).toMatch(
        /toast\.error|setError|setNotice|setToast|setErr\(|flash\(false|failAction\(/
      )
    })
  }

  it('runAction 现在只给"真做成了"的动作弹绿 toast（null＝失败已由 fn 弹过错）', () => {
    const src = readCode('../src/renderer/src/modules/settings/DataHealthPanel.tsx')
    const a = src.indexOf('const runAction = useCallback(')
    expect(a).toBeGreaterThanOrEqual(0)
    const body = src.slice(a, a + 420)
    expect(body, '回到无条件 toast.success(await fn()) 就是本批改前的形状').toMatch(/if \(text !== null\) toast\.success/)
    expect(body).toContain('Promise<string | null>')
  })

  it('failAction 助手本体必须真判失败并弹提示（抽出去不等于放松闸门）', () => {
    const src = readCode('../src/renderer/src/modules/settings/DataHealthPanel.tsx')
    const a = src.indexOf('const failAction = ')
    expect(a, 'failAction 没了就直接红').toBeGreaterThanOrEqual(0)
    const body = src.slice(a, a + 220)
    expect(body).toContain('hasIpcFailed(r)')
    expect(body).toContain('toast.error(')
    expect(body).toMatch(/return true/)
    expect(body).toMatch(/return false/)
  })

  it('这一档的提示一律取 IPC 的 error 字段（四语面归 §206/§209 那一族的延伸，本批不写了死中文）', () => {
    for (const rel of FILES) {
      expect(readCode(rel), rel).toContain('ipcFailText(')
    }
  })
})

describe('③ 闸门看得见行的前提：9 个文件都得是纯 LF 或纯 CRLF，不许有孤立 CR', () => {
  // 本批写 OllamaPanel 时插入的那 5 行用了孤立 CR：JS 里 CR 是合法行结束符 ⇒ 运行期没问题、typecheck 也过，
  // 但 git 把整个文件判成 binary（以后 `git diff` 不再给这块任何审阅面），而按 \n 切行的闸门把守卫和它上面的
  // `//` 注释读成同一行 —— 那道假绿就是这么来的。这条用例把这个"工具链盲区"本身钉住。
  const countOf = (buf: Buffer, byte: number): number => {
    let n = 0
    for (const x of buf) if (x === byte) n++
    return n
  }
  for (const rel of FILES) {
    it(`${rel.split('/').pop()} 无孤立 CR`, () => {
      const b = readRaw(rel)
      let lfBeforeCR = 0
      for (let i = 0; i < b.length; i++) if (b[i] === 0x0d && b[i + 1] !== 0x0a) lfBeforeCR++
      expect(lfBeforeCR, `${rel} 有 ${lfBeforeCR} 个不跟 LF 的 CR ⇒ git 判 binary`).toBe(0)
      expect(countOf(b, 0x00), rel).toBe(0)
    })
  }
})
