// V4-Iter-265：闸门第六面——**命令类** IPC（这一族先只认 abort/stop/cancel 那一族）的失败侧。
//
// 前五面量的都是**读**：拿到失败对象当数据用（1–3 面）、判了不接管（4 面）、判了也只 return（5 面）。
// 命令类是另一张脸：用户按了一颗键、期望主进程**做一件事**，而 `safeHandle` 把主进程的失败
// 变成**已 resolve 的 `{ok:false,error}`**（src/main/ipc/safe-handle.ts:179-182）⇒
// 只挂 `.catch(reportIpcError(...))` 的那六处对这种失败是死代码，裸发的两处连 `.catch` 都没有。
//
// 两轴判据（缺一不可，跟 §263 同一条纪律）：
//  ① 这一发的结果**完全没判**（没 await 后判真值、没 `.then(r => 判)`；`.catch` 单独不算判）；
//  ② 分水岭第二轴＝**同一颗键的处理器里，界面自己改成"这件事已办成"的样子**
//     （`setRunning*(false)`／`setStreaming(false)`／`setPulling(null)`）。
//  ② 为什么是分水岭：写"已办成"＝屏幕在替这次失败作证（那一轮还在跑、token 还在烧，键却回到"发送"）＝谎报；
//  不写＝原地不动、点了没反应（fail-closed，§263 已定过"不算谎报、不进名单"）——它仍是待收的静默，但不是同一档。
//
// 开批现查（`data/tmp/scan-265.mjs`，宽严两版都跑过）：**目标桶 2／静默桶 7／对照桶 5**。
//  严版第一刀砍掉一条假阳：`OllamaPanel.tsx:144` 的 `stopTimerRef.current = null` 是**定时器句柄**，
//  不是"在跑"这件事的状态；把它算成"自述已停"就成假阳（宽松版留着这条，用来暴露判据自己）。
//  本批收掉目标桶那两处（`useAgentChat.ts` 的 abortAgent、`PopupApp.tsx` 的 abortChat）⇒ 目标桶归零；
//  静默桶 7 处一条没动，逐条登记在下面。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(__dirname, '..')
const RENDERER_DIR = 'src/renderer/src'
const CMD_RE = /^(abort|stop|cancel)/i

/** 抹掉注释再扫：注释里写的"停止"不算界面做了什么（§217 同一条纪律） */
const blankComments = (code: string): string =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => `${p1}${' '.repeat(_m.length - p1.length - 1)}`)

const filesIn = (dir: string): string[] => {
  const abs = path.join(ROOT, dir)
  const out: string[] = []
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const p = path.join(abs, e.name)
    if (e.isDirectory()) out.push(...filesIn(path.relative(ROOT, p)))
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(path.relative(ROOT, p).replace(/\\/g, '/'))
  }
  return out
}

type Site = { file: string; line: number; ch: string; judged: boolean; claims: boolean; body: string }

/** 这一发的结果判没判：await 绑定后判真值／`.then(r => 判)` 算判；只有 `.catch` 或裸发都不算 */
function resultJudged(call: ts.CallExpression, fn: ts.Node): boolean {
  const parent = call.parent
  let bound: string | null = null
  if (ts.isAwaitExpression(parent)) {
    const up = parent.parent
    if (up && ts.isVariableDeclaration(up)) bound = up.name.getText()
    else if (up && ts.isBinaryExpression(up) && up.operatorToken.kind === ts.SyntaxKind.EqualsToken) bound = up.left.getText()
  }
  if (bound) {
    const body = fn.getText()
    return [
      new RegExp(`hasIpcFailed\\(\\s*${bound}\\b`),
      new RegExp(`${bound}\\.ok\\b`),
      new RegExp(`${bound}\\.stopped\\b`)
    ].some((re) => re.test(body))
  }
  let up: ts.Node = parent
  while (up && !ts.isExpressionStatement(up) && !ts.isVariableStatement(up)) {
    if (ts.isCallExpression(up) && ts.isPropertyAccessExpression(up.expression) && up.expression.name.text === 'then') {
      const cb = up.arguments[0]
      return !!cb && /hasIpcFailed\(|\.ok\b|\.stopped\b/.test(cb.getText())
    }
    if (ts.isCallExpression(up) && ts.isPropertyAccessExpression(up.expression) && up.expression.name.text === 'catch') return false
    up = up.parent
  }
  return false
}

/** 第二轴：这一发之后，同一函数体里有没有把"在跑"这件事关掉的写 */
function claimsDone(fn: ts.Node, call: ts.CallExpression): boolean {
  const after = fn.getText().slice(call.end - fn.getStart())
  return [
    /set[A-Za-z]*Running[A-Za-z]*\(false\)/,
    /set[A-Za-z]*Streaming\(false\)/,
    /set[A-Za-z]*Pulling\(null\)/
  ].some((re) => re.test(after))
}

function scanSource(file: string, code: string): Site[] {
  const src = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const out: Site[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      /^window\.pocketai$/.test(node.expression.expression.getText()) &&
      CMD_RE.test(node.expression.name.text)
    ) {
      const fn = ts.findAncestor(node, (n) => ts.isArrowFunction(n) || ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n))
      if (fn) {
        out.push({
          file,
          line: src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1,
          ch: node.expression.name.text,
          judged: resultJudged(node, fn),
          claims: !resultJudged(node, fn) && claimsDone(fn, node),
          body: fn.getText().replace(/\s+/g, ' ').slice(0, 90)
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(src)
  return out
}

const SITES = filesIn(RENDERER_DIR).flatMap((rel) => scanSource(rel, blankComments(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n'))))
/** 目标桶：没判 ∧ 界面自述"已办成"＝替这次失败作证 */
const LIE = SITES.filter((s) => !s.judged && s.claims)
/** 静默桶：没判 ∧ 界面不动＝点了没反应（§263 已定：不算谎报，但仍是这一族的待收／设计内） */
const SILENT = SITES.filter((s) => !s.judged && !s.claims)
/** 对照桶：判过了（正解形状，包括 §246 的 `stopProbe`） */
const JUDGED = SITES.filter((s) => s.judged)

/**
 * 等式 ratchet：
 *  · 目标桶收口后**必须为 0**——谁把 `setStreaming(false)` 放回一个不判结果的停止旁边就红；
 *  · 静默桶 7 处（本批一条没收，逐文件登记在下面；收一处就减一格，新增也红）。
 */
const LIE_CAP = 0
const SILENT_CAP = 7

const SILENT_PER_FILE: Record<string, number> = {
  // 卸载清理路径上的中止：屏都已经没了，没有可谎报的对象；失败留痕在 console 是设计内（注释自己写着）。
  // 要不要给个"离开时没停住"的提示＝待决策（用户看不见那一屏，说话没有落点）。
  'src/renderer/src/modules/translate/TranslateModule.tsx': 2,
  'src/renderer/src/modules/image/ImageModule.tsx': 2,
  // 停止键那三处：不判结果、界面也不自述已停（等 DONE／ERROR 事件自己收尾）⇒ 点了没反应，待收。
  // 与 §263 那五处同一档"待收"，本批先只收谎报那一档（立面的第一批）。
  'src/renderer/src/modules/chat/useStreamSession.ts': 1,
  // 拉模型那颗 ✕：`pulling` 由 `pullOllamaModel` 自己 settle 收尾，abort 失败时进度条继续走＝没自述已停。
  'src/renderer/src/hooks/useOllamaPull.ts': 1,
  // 停止 ollama 服务：await 的结果整个丢，但 800ms 后 `refresh()` 从主进程回读真状态 ⇒ 不摆在"已停"上。
  'src/renderer/src/components/OllamaPanel.tsx': 1
}

describe('§265 第六面：命令类那发「按了停止」——判没判 ∧ 界面有没有自述已停（先验扫描器自己）', () => {
  const sample = (name: string, code: string): Site[] =>
    scanSource(name, blankComments(code))

  it('合成源码：五种写法各归对桶（判据恒真或恒假都会在这里红）', () => {
    const sites = sample('synth.tsx', `
      const a = () => { window.pocketai.abortChat(id); setStreaming(false) }
      const b = () => { window.pocketai.abortChat(id) }
      const c = async () => { const r = await window.pocketai.abortChat(id); if (hasIpcFailed(r)) say(r.error) }
      const d = () => { window.pocketai.abortChat(id).then((r) => { if (!r.ok) say(r.error) }); setStreaming(false) }
      const e = () => { window.pocketai.abortChat(id).catch(reportIpcError('x.abort')) }
    `)
    const at = (i: number): Site => sites[i]!
    expect(sites, '五条停止都该被扫到').toHaveLength(5)
    expect([at(0).judged, at(0).claims], 'a＝没判＋自述已停 ⇒ 目标桶').toEqual([false, true])
    expect([at(1).judged, at(1).claims], 'b＝没判、也不自述 ⇒ 静默桶').toEqual([false, false])
    expect([at(2).judged, at(2).claims], 'c＝await 后判 ⇒ 对照桶').toEqual([true, false])
    expect([at(3).judged, at(3).claims], 'd＝`.then` 里判了 ⇒ 对照桶（判了就不算这一族，哪怕界面自述已停）').toEqual([true, false])
    expect([at(4).judged, at(4).claims], 'e＝只有 .catch ⇒ 对 safeHandle 的失败对象是死代码，仍算没判').toEqual([false, false])
  })

  it('第二轴的假阳要被看见：定时器句柄置 null 不算"自述已停"（宽松版才把它算进来）', () => {
    const timerOnly = sample('timer.tsx', `
      async function handleStop() { try { await window.pocketai.stopOllama() } catch (e) { setErr(e) }; timerRef.current = null }
    `)
    expect(timerOnly[0]!.claims, '只写 timerRef.current = null ⇒ 不进目标桶（严版判据）').toBe(false)
    const real = sample('real.tsx', `
      const stop = () => { window.pocketai.abortChat(id); requestIdRef.current = null; setStreaming(false) }
    `)
    expect(real[0]!.claims, '同一颗键里写 setStreaming(false) ⇒ 进目标桶').toBe(true)
  })

  it('真仓不是空转：三桶守恒、且目标桶与静默桶不同数（判若恒真／恒假都会在这里红）', () => {
    expect(SITES.length, '停止族的调用点总数（本批现查 14）').toBeGreaterThan(10)
    expect(LIE.length + SILENT.length + JUDGED.length, '三桶之和＝总数').toBe(SITES.length)
    expect(JUDGED.length, '对照桶必须非空（一面闸门看不见正解也要能看见）').toBeGreaterThan(0)
    expect(SILENT.length, '静默桶必须非空').toBeGreaterThan(0)
  })

  it(`等式 ratchet：目标桶 ${LIE_CAP} 处（§265 开批 2 → 收两处）、静默桶 ${SILENT_CAP} 处`, () => {
    expect(LIE, `现数 ${LIE.length}：\n${LIE.map((s) => `  ${s.file}:${s.line} ${s.ch}() ⇒ ${s.body}`).join('\n')}`).toHaveLength(LIE_CAP)
    expect(
      SILENT,
      `现数 ${SILENT.length}：\n${SILENT.map((s) => `  ${s.file}:${s.line} ${s.ch}() ⇒ ${s.body}`).join('\n')}`
    ).toHaveLength(SILENT_CAP)
  })

  it('静默桶逐文件登记之和＝CAP（漏登记一个文件就会藏住新的点）', () => {
    const got: Record<string, number> = {}
    for (const s of SILENT) got[s.file] = (got[s.file] ?? 0) + 1
    expect(got, '逐文件现数与登记表逐条相符（多了＝新增，少了＝收了口没调小登记）').toEqual(SILENT_PER_FILE)
    const registered = Object.values(SILENT_PER_FILE).reduce((a, b) => a + b, 0)
    expect(registered, '登记表总数必须等于 CAP').toBe(SILENT_CAP)
  })

  it('正向对照：本批收口的两处与既有五处正解，都必须在"判过了"那一桶里', () => {
    const judgedFiles = JUDGED.map((s) => s.file)
    for (const f of [
      'src/renderer/src/modules/agent/hooks/useAgentChat.ts',
      'src/renderer/src/popup/PopupApp.tsx',
      'src/renderer/src/modules/settings/ProviderSettings.tsx',
      'src/renderer/src/modules/agent/chat/AgentEvalPanel.tsx',
      'src/renderer/src/modules/agent/channels/ChannelsPanel.tsx',
      'src/renderer/src/modules/agent/mcp/McpPanel.tsx',
      'src/renderer/src/components/RemindersModal.tsx'
    ]) {
      expect(judgedFiles, `${f} 的停止那发该是"判过了"的形状`).toContain(f)
    }
    for (const f of ['src/renderer/src/modules/translate/TranslateModule.tsx', 'src/renderer/src/modules/image/ImageModule.tsx']) {
      expect(
        LIE.map((s) => s.file),
        `${f} 一条都不该回到目标桶`
      ).not.toContain(f)
    }
  })

  it('§265 两处的形状数得出（unread 两路各写一次、重试键各一颗、裸交出去归零、preload 类型带 error）', () => {
    const read = (rel: string): string =>
      fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
    const HOOK = read('src/renderer/src/modules/agent/hooks/useAgentChat.ts')
    const POPUP = read('src/renderer/src/popup/PopupApp.tsx')
    const count = (src: string, re: RegExp): number => (src.match(re) ?? []).length
    for (const [f, src] of [['useAgentChat', HOOK], ['PopupApp', POPUP]] as const) {
      expect(count(src, /setStopUnread\(\{ error: /g), `${f}：resolve 的失败对象与 reject 各写一次 unread`).toBe(2)
      expect(count(src, /setStopUnread\(null\)/g), `${f}：发送前收回上一句＋这回落成功即收回，共两处`).toBe(2)
      expect(count(src, /requestId: id/g), `${f}：记住那一发的 requestId，"再送一次"才有对象`).toBe(2)
      expect(count(src, /\.catch\(reportIpcError\('(?:agent|popup)\.abort/g), `${f}：不该再有"只进 console"那一形`).toBe(0)
    }
    expect(count(HOOK, /const retryStop = /g), 'hook 自己导出"再送一次"').toBe(1)
    expect(count(read('src/renderer/src/modules/agent/chat/AgentPanel.tsx'), /chat\.retryStop/g), '那颗重试键真接得上').toBe(1)
    expect(count(read('src/renderer/src/modules/agent/chat/AgentPanel.tsx'), /common\.stopNotSent/g), 'Agent 页挂那句').toBe(1)
    expect(count(POPUP, /common\.stopNotSent/g), '浮窗挂那句（同一个界面名词只留一份键，§263 同一条）').toBe(1)
    const PRELOAD = read('src/preload/index.ts')
    expect(count(PRELOAD, /abortAgent: \(requestId: string\): Promise<\{ ok: boolean; error\?: string \}>/g), 'preload 类型带失败分支').toBe(1)
    expect(count(PRELOAD, /abortChat: \(requestId: string\): Promise<\{ ok: boolean; error\?: string \}>/g), 'abortChat 同').toBe(1)
    expect(count(read('src/preload/popup.ts'), /abortChat: \(requestId: string\): Promise<\{ ok: boolean; error\?: string \}>/g), '浮窗那份也同').toBe(1)
  })
})
