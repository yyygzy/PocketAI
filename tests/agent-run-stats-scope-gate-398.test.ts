// §398 常驻闸门：「本次运行统计」这一格问的是**哪一次运行**——两问必须分两发，一条链都不许混
//
// 本枚收的是 §396 留下那笔账。判据分三段：
//   A 前提（真库）：本轮零行时，"会话最近一次"那把尺子真的会退到上一轮——缺陷不是推测，是现量；
//   B 接线（源码级）：新通道那颗常量／handler 用的是按运行的 repo 方法／preload 带失败分支／
//     hook 两发各自的身份／面板那颗重试键只有一个出口；
//   C 读法自证：把"改前那一版"的形状喂进同一套读法，必须被认成"没分岔"。
//
// 计数一律读**去掉注释后的源码**（第 33 条：自己写的注释会把同一串撑大→假红／假绿）；
// 取锚点全部写在 `it` 里面（§396 的教训：写在 `describe` 期一漂就整份文件收集期崩，变异轮会把抓到报成存活）。
// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const P = vi.hoisted(() => {
  const base = process.env.TEMP || process.env.TMP || '/tmp'
  const sep = base.indexOf('\\') >= 0 ? '\\' : '/'
  const dir = base + sep + 'pocketai-run-stats-scope-398'
  return { dir, data: dir + sep + 'data', db: dir + sep + 'data' + sep + 'app.db' }
})
vi.mock('../src/main/portable', () => ({ DATA_DIR: P.data, DB_PATH: P.db }))
vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => P.dir, getPath: () => P.dir }
}))
vi.mock('../src/main/logger', () => ({
  createLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
}))

const ROOT = path.resolve(__dirname, '..')
const raw = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf-8')

/** 剥掉块注释与行注释（字符串与模板原样保留） */
function stripComments(src: string): string {
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (c === '/' && n === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      continue
    }
    if (c === '/' && n === '/') {
      const end = src.indexOf('\n', i + 2)
      i = end < 0 ? src.length : end + 1
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const q = c
      out += c
      i++
      while (i < src.length) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] ?? ''); i += 2; continue }
        out += src[i]
        if (src[i] === q) { i++; break }
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 取 `<decl>` 之后第一个大括号配平的块（含收尾括号） */
function blockAfter(src: string, decl: string): string {
  const i = src.indexOf(decl)
  expect(i, `找不到 ${decl}`).toBeGreaterThan(-1)
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') {
      depth--
      if (depth === 0) return src.slice(open, j + 1)
    }
  }
  throw new Error(`${decl} 的大括号不配平`)
}

const HOOK = 'src/renderer/src/modules/agent/hooks/useAgentChat.ts'
const PANEL = 'src/renderer/src/modules/agent/chat/AgentPanel.tsx'
const HANDLER = 'src/main/ipc/handlers/agent.ts'
const PRELOAD = 'src/preload/index.ts'
const TYPES = 'src/shared/types.ts'

describe('A 前提：本轮零行时，"会话最近一次"真的会退到上一轮（真库现量）', () => {
  let dbService: typeof import('../src/main/db/database')['dbService']
  let agentTraceRepo: typeof import('../src/main/db/repositories/agent-trace.repo')['agentTraceRepo']

  beforeAll(async () => {
    fs.rmSync(P.dir, { recursive: true, force: true })
    fs.mkdirSync(P.data, { recursive: true })
    const mod = await import('../src/main/db/database')
    dbService = mod.dbService
    dbService.open()
    dbService.runMigrations()
    agentTraceRepo = (await import('../src/main/db/repositories/agent-trace.repo')).agentTraceRepo
  })

  afterAll(() => {
    try { dbService.close() } catch { /* 关不掉不掩盖结论 */ }
    try { fs.rmSync(P.dir, { recursive: true, force: true }) } catch { /* scratch 残骸交给系统临时目录 */ }
  })

  it('上一轮落了行、本轮一行都没落⇒会话那把尺子回的是**上一轮那份非零**，按运行那把回三个 0', () => {
    const CONV = 'conv-398-stale'
    const prev = 'req-prev'
    const current = 'req-current-零行'
    agentTraceRepo.insert({ requestId: prev, conversationId: CONV, stepIndex: 0, stepType: 'llm', status: 'success', durationMs: 900, tokenUsage: 1200 })
    agentTraceRepo.insert({ requestId: prev, conversationId: CONV, stepIndex: 1, stepType: 'tools', toolName: 'shell', status: 'success', durationMs: 300, tokenUsage: 400 })
    // 本轮：engine 的 `safeTrace` 写失败只 warn ⇒ 库里这一轮一行都没有，而 DONE 事件照样发得出来
    expect(agentTraceRepo.latestStatsByConversation(CONV), '现数会话最近一次').toEqual({
      totalDurationMs: 1200, totalTokens: 1600, stepCount: 2
    })
    expect(agentTraceRepo.statsByRequest(current), '现数按本轮那一发').toEqual({
      totalDurationMs: 0, totalTokens: 0, stepCount: 0
    })
    // 这一对的差就是本枚的缺陷：渲染层当时问的是第一个，画的却写着「本次运行统计」
    expect(agentTraceRepo.latestStatsByConversation(CONV)?.stepCount, '两把尺子给出同一个数就不叫缺陷了').not.toBe(
      agentTraceRepo.statsByRequest(current).stepCount
    )
  })

  it('反向对照：本轮落了行⇒两把尺子都指本轮（会话那一把不是恒错，只在零行那一档才退）', () => {
    const CONV = 'conv-398-fresh'
    const prev = 'req-prev-2'
    const current = 'req-current-有行'
    agentTraceRepo.insert({ requestId: prev, conversationId: CONV, stepIndex: 0, stepType: 'llm', status: 'success', durationMs: 10, tokenUsage: 10 })
    agentTraceRepo.insert({ requestId: current, conversationId: CONV, stepIndex: 0, stepType: 'llm', status: 'success', durationMs: 700, tokenUsage: 800 })
    agentTraceRepo.insert({ requestId: current, conversationId: CONV, stepIndex: 1, stepType: 'tools', toolName: 'fs_read', status: 'success', durationMs: 100, tokenUsage: 200 })
    const byConv = agentTraceRepo.latestStatsByConversation(CONV)
    const byRun = agentTraceRepo.statsByRequest(current)
    expect(byConv).toEqual(byRun)
    expect(byRun.stepCount).toBe(2)
  })

  it('会话里一行都没有⇒会话那把回 null（安静），按运行那把仍回三个 0：两问各有各的脸，不许互相折', () => {
    const CONV = 'conv-398-empty'
    expect(agentTraceRepo.latestStatsByConversation(CONV)).toBeNull()
    expect(agentTraceRepo.statsByRequest('req-never-ran')).toEqual({ totalDurationMs: 0, totalTokens: 0, stepCount: 0 })
  })
})

describe('B 接线：一颗通道一个问法，两发各有身份', () => {
  it('契约：新那颗常量在，且与会话那颗是**两个串**（一把尺子不许量两问——§391 那枚就是这么谎报的）', () => {
    const t = stripComments(raw(TYPES))
    // 读法也要钉（第 41 条）：不是"文件里含这串"，而是把两颗常量各自的串名抠出来比
    const byConv = /AGENT_GET_LATEST_RUN_STATS:\s*'([^']+)'/.exec(t)?.[1]
    const byRun = /AGENT_GET_RUN_STATS:\s*'([^']+)'/.exec(t)?.[1]
    expect(byConv, '会话那颗没读出来').toBe('agent:get-latest-run-stats')
    expect(byRun, '新那颗没读出来').toBe('agent:get-run-stats')
    expect(byRun === byConv, '两颗问法共用一个串名＝消费面又要开始猜').toBe(false)
  })

  it('主进程：那一发用的是 `statsByRequest`（不是 `latestStatsByConversation`），并带 idSchema', () => {
    const h = stripComments(raw(HANDLER))
    const at = h.indexOf('IPC.AGENT_GET_RUN_STATS')
    expect(at, 'handler 里没有那颗新通道').toBeGreaterThan(-1)
    // 从通道名往后取那一发 safeHandle 的调用（到配平的右括号为止）——取窗口而非整份文件，
    // 免得别的 handler 里的同名调用把判据喂绿
    const body = h.slice(at, at + 400)
    expect(body).toContain('agentTraceRepo.statsByRequest(requestId)')
    expect(body.includes('latestStatsByConversation'), '这一发不许退回会话那把尺子').toBe(false)
    expect(body).toContain('argsSchema(idSchema)')
    // 会话那一发对"零行"折成 null（那是"这个会话没跑过"），按运行这一发**不许**跟着折：
    // 零行是这一轮的真值，屏上就该是「0 步」，把它折成沉默＝§396 那条反向对照的另一面
    expect(body.includes('stepCount === 0'), '按运行那一发把零行折成了"没有"').toBe(false)
  })

  it('preload：成员在、invoke 的是那颗新通道、类型**带失败分支**（safeHandle 下失败是已 resolve 的对象）', () => {
    const p = stripComments(raw(PRELOAD))
    const at = p.indexOf('getRunStats:')
    expect(at, 'preload 里没有 getRunStats').toBeGreaterThan(-1)
    const line = p.slice(at, p.indexOf('\n', p.indexOf('ipcRenderer.invoke', at)))
    expect(line).toContain('Promise<AgentRunStats | { ok: false; error: string }>')
    expect(line, '现数那一行：' + line).toContain('IPC.AGENT_GET_RUN_STATS')
    expect(line.includes('AGENT_GET_LATEST_RUN_STATS'), '拿会话那颗通道冒充按运行＝整条链白接').toBe(false)
  })

  it('hook：两发各自读各自的通道（按机关身份钉，不是数次数）', () => {
    const hook = stripComments(raw(HOOK))
    const byConv = blockAfter(hook, 'const loadRunStats = useCallback((id: string)')
    expect(byConv).toContain('window.pocketai.getLatestRunStats(id)')
    expect(byConv.includes('window.pocketai.getRunStats('), '会话那一发不许顺手也去按运行问').toBe(false)
    const byRun = blockAfter(hook, 'const loadRunStatsForRun = useCallback((runConversationId: string, requestId: string)')
    expect(byRun).toContain('window.pocketai.getRunStats(requestId)')
    expect(byRun.includes('getLatestRunStats('), '按运行那一发不许退回会话那把尺子').toBe(false)
  })

  it('hook：DONE 兜底那一支问的是这一轮，带的是**事件里那颗 requestId**（不是会话 id）', () => {
    const hook = stripComments(raw(HOOK))
    const at = hook.indexOf('if (e.traceStats) {')
    expect(at, 'DONE 那一支的门被改了').toBeGreaterThan(-1)
    const rest = hook.slice(at)
    const elseArm = rest.slice(rest.indexOf('} else {'))
    expect(elseArm).toContain('loadRunStatsForRun(e.conversationId, e.requestId)')
    expect(elseArm.includes('loadRunStats(e.conversationId)'), '改前形状＝问错了对象').toBe(false)
  })

  it('面板：那颗重试键只有一个出口，且出口问的是"上一次那个问题"（不留第二个入口去问会话）', () => {
    const panel = stripComments(raw(PANEL))
    expect(panel).toContain('data-testid="run-stats-retry"')
    expect(panel).toContain('chat.retryRunStats()')
    expect(panel.includes('chat.loadRunStats('), '一格两个出口＝哪句说的是真话看不出来').toBe(false)
    // 那一格的条件链仍是 §264 那三个条件（本枚零新文案、没动门）
    expect(panel).toContain("!chat.running && !chat.runStats && chat.runStatsUnread")
  })

  it('hook：这一格的身份只有一颗 ref，三处消费者都读它（多处共用机关要按身份钉）', () => {
    const hook = stripComments(raw(HOOK))
    // 写身份的只有一个地方＝DONE 那一支（且排在会话归属判据之内）
    const doneAt = hook.indexOf('if (e.conversationId === conversationIdRef.current) {')
    expect(doneAt, 'DONE 那一支的会话归属门被改了').toBeGreaterThan(-1)
    const doneBlock = blockAfter(hook.slice(doneAt), 'if (e.conversationId === conversationIdRef.current)')
    expect(doneBlock).toContain('runBlockRef.current = { conversationId: e.conversationId, requestId: e.requestId }')
    // 写的总共两处＝DONE 记身份＋挂载那一发清身份；没有第三处偷偷改写
    expect((hook.match(/runBlockRef\.current = /g) ?? []).length, '现数身份写入次数').toBe(2)
    expect((hook.match(/runBlockRef\.current = null/g) ?? []).length, '清身份＝挂载那一发一处').toBe(1)
    // 读的恰好两处＝那颗「重试」与展开明细（兜底重读不问它，它拿的是事件里现成的 requestId）
    expect((hook.match(/const run = runBlockRef\.current/g) ?? []).length, '现数身份的读者').toBe(2)
    const retry = blockAfter(hook, 'const retryRunStats = useCallback(')
    expect(retry).toContain('const run = runBlockRef.current')
    expect(retry).toContain('loadRunStatsForRun(run.conversationId, run.requestId)')
    expect(retry).toContain('loadRunStats(convId)')
    // 成对判据绑在同一条 if 之内（第 34 条）：有身份那一支里不许混进会话那一发
    const runArm = retry.slice(retry.indexOf('if (run) {'))
    expect(runArm.slice(0, runArm.indexOf('return')), '有身份那一支不许混进会话那一发').not.toContain('loadRunStats(')
  })

  it('明细那一格与统计同一颗身份：有身份走按运行，没身份才走会话最近一次', () => {
    const hook = stripComments(raw(HOOK))
    const traces = blockAfter(hook, 'const loadLatestTraces = useCallback(')
    expect(traces).toContain('const run = runBlockRef.current')
    expect(traces).toContain('window.pocketai.getRunTraces(run.requestId)')
    expect(traces).toContain('window.pocketai.getLatestRunTraces(convId)')
    // 两条通道各归各：按运行那一支不许顺带问会话那颗（反之亦然）——按三元表达式整体读
    expect(/run \? window\.pocketai\.getRunTraces\(run\.requestId\) : window\.pocketai\.getLatestRunTraces\(convId\)/.test(traces),
      '现数那一行的分岔写法') .toBe(true)
    // §398 的运行守卫与§221 那条"失败只跳过写数据"的口径共存：卡加载态那一支仍然收
    expect((traces.match(/setTracesLoading\(false\)/g) ?? []).length, '现数 setTracesLoading(false)').toBeGreaterThanOrEqual(3)
  })

  it('明细分支：新通道那颗常量、handler 用 `listByRequest`、preload 带失败分支', () => {
    const t = stripComments(raw(TYPES))
    expect(/AGENT_GET_RUN_TRACES:\s*'agent:get-run-traces'/.test(t), '明细那颗新常量没读出来').toBe(true)
    const h = stripComments(raw(HANDLER))
    const at = h.indexOf('IPC.AGENT_GET_RUN_TRACES')
    expect(at, 'handler 里没有明细那颗新通道').toBeGreaterThan(-1)
    const body = h.slice(at, at + 300)
    expect(body).toContain('agentTraceRepo.listByRequest(requestId)')
    expect(body.includes('latestTracesByConversation'), '明细这一发不许退回会话那把尺子').toBe(false)
    expect(body).toContain('argsSchema(idSchema)')
    const p = stripComments(raw(PRELOAD))
    const pa = p.indexOf('getRunTraces:')
    expect(pa, 'preload 里没有 getRunTraces').toBeGreaterThan(-1)
    const line = p.slice(pa, p.indexOf('\n', p.indexOf('ipcRenderer.invoke', pa)))
    expect(line).toContain('Promise<AgentTraceRecord[] | { ok: false; error: string }>')
    expect(line).toContain('IPC.AGENT_GET_RUN_TRACES')
  })

  it('按运行那一发两道守卫都在（会话＋运行），摘任一道就是另一种假话', () => {
    const hook = stripComments(raw(HOOK))
    const byRun = blockAfter(hook, 'const loadRunStatsForRun = useCallback((runConversationId: string, requestId: string)')
    expect((byRun.match(/if \(conversationIdRef\.current !== runConversationId\) return/g) ?? []).length, '现数会话守卫').toBe(2)
    expect((byRun.match(/if \(requestIdRef\.current !== requestId\) return/g) ?? []).length, '现数运行守卫').toBe(2)
  })
})

describe('C 读法自证：改前那一版喂进同一套读法，必须被认成"没分岔"', () => {
  it('合成形状（DONE 兜底走会话那一发＋面板出口直接调会话那一发）⇒ B 的两颗判据都要红', () => {
    const bad = stripComments(`if (e.traceStats) {
  setRunStats(e.traceStats)
  setRunStatsUnread(null)
} else {
  setRunStats(null)
  loadRunStats(e.conversationId)
}`)
    const rest = bad.slice(bad.indexOf('} else {'))
    expect(rest.includes('loadRunStatsForRun('), '改前那一版没有"按运行"这一发＝判据该认出来').toBe(false)
    const badPanel = stripComments(`onClick={() => { if (chat.conversationId) chat.loadRunStats(chat.conversationId) }}`)
    expect(badPanel.includes('retryRunStats'), '改前的面板出口问的是会话').toBe(false)
  })

  it('反向对照：现行源码过同一套读法（合成段能被抓红不代表读法本身空转）', () => {
    const hook = stripComments(raw(HOOK))
    expect(hook.includes('loadRunStatsForRun(e.conversationId, e.requestId)'), '现数 hook 里那一支').toBe(true)
    expect(stripComments(raw(PANEL)).includes('chat.retryRunStats()')).toBe(true)
  })

  it('本枚零新文案：四语字典里不许冒出"按运行"这类新键（那张脸复用 §264 那颗）', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const d = stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${lang}.ts`), 'utf-8'))
      expect(d, `${lang} 冒出了新键`).not.toContain("'agent.runStatsByRun'")
      expect(d, `${lang} 冒出了新键`).not.toContain("'agent.runStatsThisRun'")
    }
  })
})
