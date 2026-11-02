// §396 常驻闸门：Agent 运行统计「没读到」与「读到 0」是两件事，从主进程到那一格一条链都不许塌
//
// 钉的是**结构**（行为那一半在 `renderer-run-stats-unread-396.test.tsx`，
// 面板那张脸本身在 §264 的 `ipc-jump-read-264.test.tsx`）：
//   A 生产侧：读不出来回 null（不许回一份 0），DONE 事件那颗写成 `?? undefined`
//   B 契约：那颗仍是**可选**字段（必填＝逼生产侧造假值），注释写明"只在真读到才带"
//   C 消费侧：两半各有牙——带⇒填值＋收句；不带⇒先复位再走同一条重读路；改前那串 `?? null` 不许回来
//   D 那张脸：复用的三个条件半半齐在＋那颗重试键仍在同一格＋引的还是那颗既有键（本枚零新键）
//   E 读法自证：改前两种形状喂进同一套读法，必须被认成"没判／没接管"
//
// 计数一律读**去掉注释后的源码**（第 33 条：自己写的注释会把同一串撑大→假红／假绿）。
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const raw = (rel: string): string => fs.readFileSync(path.join(ROOT, 'src', rel), 'utf-8')

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

/** 取 `<decl>` 之后第一个大括号配平的块 */
function blockAfter(src: string, decl: string): string {
  const i = src.indexOf(decl)
  expect(i, `找不到 ${decl}`).toBeGreaterThan(-1)
  const open = src.indexOf('{', i)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(open, j + 1) }
  }
  throw new Error(`${decl} 的大括号不配平`)
}

const ENGINE = stripComments(raw('main/agent/engine.ts'))
const TYPES = stripComments(raw('shared/types.ts'))
const CHAT = stripComments(raw('renderer/src/modules/agent/hooks/useAgentChat.ts'))
const PANEL = stripComments(raw('renderer/src/modules/agent/chat/AgentPanel.tsx'))
const ZEROS = '{ totalDurationMs: 0, totalTokens: 0, stepCount: 0 }'

describe('A 生产侧：读不出来＝null，不是一份 0', () => {
  // 取法一律在 `it` 里跑：写在 describe 期＝锚点一漂整份文件在收集期崩，
  // 变异轮里它只会显示成"这个文件 0 tests"，红数被记成 0（差点把抓到当成存活）
  const fn = (): string => blockAfter(ENGINE, 'function safeTraceStats')

  it('签名回 `AgentRunStats | null`，catch 支回 null', () => {
    expect(ENGINE).toContain('function safeTraceStats(requestId: string): AgentRunStats | null')
    expect(fn()).toMatch(/catch[\s\S]*return null/)
  })

  it('整个 engine 里不许再有那份 zeros 兜底字面量（出现＝把"没读到"重新画成"0 步 0 tokens"）', () => {
    expect(ENGINE, `现数命中 ${ENGINE.split(ZEROS).length - 1} 处`).not.toContain(ZEROS)
  })

  it('DONE 事件那颗＝`safeTraceStats(requestId) ?? undefined`（失败＝不带这一颗，而不是带一份空对象）', () => {
    expect(ENGINE).toContain('traceStats: safeTraceStats(requestId) ?? undefined')
  })
})

describe('B 契约：那颗仍是可选字段', () => {
  const iface = (): string => {
    const i = TYPES.indexOf('export interface AgentDoneEvent')
    expect(i, '找不到 AgentDoneEvent').toBeGreaterThan(-1)
    const open = TYPES.indexOf('{', i)
    let depth = 0
    for (let j = open; j < TYPES.length; j++) {
      if (TYPES[j] === '{') depth++
      else if (TYPES[j] === '}') { depth--; if (depth === 0) return TYPES.slice(i, j + 1) }
    }
    throw new Error('AgentDoneEvent 大括号不配平')
  }

  it('`traceStats?: AgentRunStats`（必填＝逼生产侧造一份默认值，那正是本枚拆掉的东西）', () => {
    expect(iface()).toContain('traceStats?: AgentRunStats')
    expect(iface()).not.toContain('traceStats: AgentRunStats')
  })

  it('旁边那颗真步数仍在（`stepCount: number`＝我们本来就知道的那一半，不靠 trace 读出来）', () => {
    expect(iface()).toContain('stepCount: number')
  })
})

describe('C 消费侧：两半各有牙', () => {
  /** 按身份取 `if (e.traceStats) { … } else { … }` 的两支（不是数出现次数，第 37 条）；同样在 `it` 里才跑 */
  const arms = (): { trueArm: string; elseArm: string } => {
    const ifAt = CHAT.indexOf('if (e.traceStats) {')
    expect(ifAt, 'DONE 里没有那颗三档判断').toBeGreaterThan(-1)
    const open = CHAT.indexOf('{', ifAt)
    let depth = 0
    let close = -1
    for (let j = open; j < CHAT.length; j++) {
      if (CHAT[j] === '{') depth++
      else if (CHAT[j] === '}') { depth--; if (depth === 0) { close = j; break } }
    }
    const trueArm = CHAT.slice(open + 1, close)
    const rest = CHAT.slice(close + 1)
    expect(rest.startsWith(' else {'), `现数 else 前缀：${JSON.stringify(rest.slice(0, 16))}`).toBe(true)
    const eOpen = rest.indexOf('{')
    depth = 0
    let eClose = -1
    for (let j = eOpen; j < rest.length; j++) {
      if (rest[j] === '{') depth++
      else if (rest[j] === '}') { depth--; if (depth === 0) { eClose = j; break } }
    }
    expect(eClose, 'else 支大括号不配平').toBeGreaterThan(-1)
    return { trueArm, elseArm: rest.slice(eOpen + 1, eClose) }
  }

  it('带⇒填那份真值并把那句收回（不许把成功的重读也拉起来）', () => {
    const { trueArm } = arms()
    expect(trueArm).toContain('setRunStats(e.traceStats)')
    expect(trueArm).toContain('setRunStatsUnread(null)')
    // §398 后这一族有两个名字（按会话／按运行），真支两样都不许拉起来
    expect(/loadRunStats(ForRun)?\(/.test(trueArm), `现数真支：${trueArm}`).toBe(false)
  })

  it('不带⇒先复位再按**这一轮**取（§398：不许顺着会话退到上一轮，也不许只把 null 摆上去就闭嘴）', () => {
    const { elseArm } = arms()
    expect(elseArm).toContain('setRunStats(null)')
    expect(elseArm).toContain('loadRunStatsForRun(e.conversationId, e.requestId)')
    expect(elseArm.indexOf('setRunStats(null)'), '顺序：旧值必须先收，否则在飞那一帧还挂着上轮数字')
      .toBeLessThan(elseArm.indexOf('loadRunStatsForRun('))
  })

  it('改前那串 `setRunStats(e.traceStats ?? null)` 不许回来（它就是"0 步"上屏的那一步）', () => {
    expect(CHAT).not.toContain('setRunStats(e.traceStats ?? null)')
  })
})

describe('D 那张脸：复用 §264 那颗，不另起句子', () => {
  const line = (): string => {
    const at = PANEL.indexOf("!chat.running && !chat.runStats && chat.runStatsUnread")
    expect(at, '面板里那颗三条件门被改了').toBeGreaterThan(-1)
    return PANEL.slice(at, PANEL.indexOf(String.fromCharCode(10), at))
  }

  it('三个条件半半齐在（不在运行＋没有统计＋有那句），引的还是那颗既有键', () => {
    const l = line()
    for (const half of ['!chat.running', '!chat.runStats', 'chat.runStatsUnread']) {
      expect(l, `现数那一行：${l}`).toContain(half)
    }
  })

  it('重试键仍在那一格里（新档不许只说话不给出口）', () => {
    expect(PANEL).toContain("data-testid=\"run-stats-retry\"")
    expect(PANEL).toContain("t('agent.runStatsBlock')")
  })

  it('本枚零新键：四语字典里不存在 `agent.runStatsUnread` 这类新串（措辞复用 §264 那句）', () => {
    for (const lang of ['zh', 'en', 'ja', 'ko']) {
      const d = stripComments(fs.readFileSync(path.join(ROOT, 'src/renderer/src/i18n', `${lang}.ts`), 'utf8'))
      expect(d, `${lang} 冒出了新键`).not.toContain("'agent.runStatsUnread'")
    }
  })
})

describe('E 读法自证：改前的两种形状喂进同一套读法，必须被认成"没判／没接管"', () => {
  it('合成一份"回 zeros"的 safeTraceStats ⇒ A 的签名与那份字面量两颗判据都要抓红', () => {
    const bad = stripComments(`function safeTraceStats(requestId: string): AgentRunStats {
  try {
    return agentTraceRepo.statsByRequest(requestId)
  } catch (e) {
    logger.warn(String(e))
    return ${ZEROS}
  }
}`)
    expect(bad.includes('): AgentRunStats | null'), '改前形状＝签名不分档').toBe(false)
    expect(bad.includes(ZEROS), '改前形状＝拿一份 0 当结果').toBe(true)
  })

  it('合成一支"不带就只 setRunStats(null)"的 handler ⇒ C 那颗"重读"判据必须抓红', () => {
    const bad = stripComments(`if (e.traceStats) {
  setRunStats(e.traceStats)
  setRunStatsUnread(null)
} else {
  setRunStats(null)
}`)
    const [, elseArm = ''] = bad.split(/\}\s*else\s*\{/)
    // §398 之后"重读"有两个名字（按会话／按运行），改前那一支两样都没有＝"没读到"与"库里没有"共用同一次沉默
    expect(/loadRunStats(ForRun)?\(/.test(elseArm), '改前形状＝"没读到"与"库里没有"共用同一次沉默').toBe(false)
  })

  it('反向对照：现行源码过同一套读法（合成段能被抓红不代表读法本身空转）', () => {
    expect(ENGINE.includes(ZEROS)).toBe(false)
    // §398：这一发改按这一轮取（`loadRunStatsForRun(e.conversationId, e.requestId)），不再是会话最近那次
    expect(CHAT).toContain('loadRunStatsForRun(e.conversationId, e.requestId)')
  })
})
