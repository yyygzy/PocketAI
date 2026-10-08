// 运行期慢操作埋点（与 boot-perf 互补：boot 管启动，本模块管运行期）
// recordPerf 记录一条事件：写 [perf] 日志 + 入内存环形缓冲（上限 100，FIFO 淘汰）。
// 数据健康面板通过 getRecentPerf 快照展示「最近慢操作」，供实测定位卡顿根因。
import { createLogger } from '../logger'
import type { PerfEvent } from '../../shared/types'

const log = createLogger('perf')

const MAX_EVENTS = 100
const events: PerfEvent[] = []

/**
 * 记录一次运行期耗时事件。
 * 调用方自行把控阈值（低于阈值不进缓冲）；日志无条件记录（info 级）。
 */
export function recordPerf(label: string, ms: number, detail?: string): void {
  const evt: PerfEvent = { label, ms: Math.round(ms), detail, at: Date.now() }
  events.push(evt)
  if (events.length > MAX_EVENTS) events.shift()
  log.info(`[perf] ${label}: ${evt.ms}ms${detail ? ` | ${detail}` : ''}`)
}

/** 最近慢操作快照（只读副本：数组与元素均拷贝，外部修改不影响内部状态） */
export function getRecentPerf(): PerfEvent[] {
  return events.map((e) => ({ ...e }))
}

/** 低于阈值事件的调试日志（不入缓冲，避免缓冲被快操作稀释） */
export function logPerfDebug(label: string, ms: number, detail?: string): void {
  log.debug(`[perf] ${label}: ${Math.round(ms)}ms${detail ? ` | ${detail}` : ''}`)
}

// ─── 聊天/Agent 流式 TTFT（首 token）与整轮耗时 ─────────────────────
// 回答「哪个模型体感慢」：TTFT 超阈值=排队/预填充/网络慢，total 超阈值=生成慢。
/** 首 token 体感阈值：超过 5s 认为值得关注 */
export const CHAT_TTFT_SLOW_MS = 5000
/** 整轮生成阈值：超过 30s 入缓冲 */
export const CHAT_TOTAL_SLOW_MS = 30_000

export interface ChatStreamPerfInput {
  /** chat=普通多模型对话；agent=Agent 单步 LLM 调用 */
  kind: 'chat' | 'agent'
  /** 首个内容/思维 delta 到达耗时（毫秒）；首包前失败可缺省 */
  ttftMs?: number
  /** streamChat 整体耗时（毫秒，必填） */
  totalMs: number
  /** 模型名（detail 归因用） */
  model: string
  /** Agent 步号（仅 kind=agent） */
  step?: number
}

/** 有效非负有限毫秒数 */
function validMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0
}

/**
 * 记录一次流式调用耗时：TTFT 与 total 独立按阈值判定，
 * 超阈值入环形缓冲（recordPerf），未超仅 debug 日志；异常值（NaN/负数）忽略。
 */
export function recordChatStreamPerf(input: ChatStreamPerfInput): void {
  const detailBase = `model=${input.model || '?'}`
  const detail = input.kind === 'agent' && typeof input.step === 'number'
    ? `${detailBase} step=${input.step}`
    : detailBase

  if (validMs(input.ttftMs)) {
    const label = `${input.kind}.ttft`
    if (input.ttftMs >= CHAT_TTFT_SLOW_MS) recordPerf(label, input.ttftMs, detail)
    else logPerfDebug(label, input.ttftMs, detail)
  }
  if (validMs(input.totalMs)) {
    const label = `${input.kind}.total`
    if (input.totalMs >= CHAT_TOTAL_SLOW_MS) recordPerf(label, input.totalMs, detail)
    else logPerfDebug(label, input.totalMs, detail)
  }
}

/** 测试用：清空缓冲 */
export function clearPerfEvents(): void {
  events.length = 0
}
