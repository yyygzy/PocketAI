// §396 常驻闸门：Agent 运行统计「没读到」与「读到 0」是两件事，从主进程到那一格一条链都不许塌
//
// 钉的是**结构**（Agent 壳已在 P4 批次 2 删除，消费侧行为与界面那两半随壳一起退场）：
//   A 生产侧：读不出来回 null（不许回一份 0），DONE 事件那颗写成 `?? undefined`
//   B 契约：那颗仍是**可选**字段（必填＝逼生产侧造假值），注释写明"只在真读到才带"
//   E 读法自证：改前那种"回 zeros"的形状喂进同一套读法，必须被认成"合成段能被抓红"
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

describe('E 读法自证：改前那种"回 zeros"的形状喂进同一套读法，必须被认成"合成段能被抓红"', () => {
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

  it('反向对照：现行源码过同一套读法（合成段能被抓红不代表读法本身空转）', () => {
    expect(ENGINE.includes(ZEROS)).toBe(false)
  })
})
