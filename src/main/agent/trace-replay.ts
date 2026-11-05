// trace 回放可用性判定（P0-5 冷 blob 第一批，v54）
//
// 三档互不兜底，判据从严：
//  · `replayable`   —— 卸载文件**与**对应 `messages` 行都在
//  · `expired`      —— 有引用记录，但文件或 `messages` 行已不在（文件被 prune、消息被删/被启动清扫）
//  · `never_stored` —— 旧行没有引用列，或内容从未超过 `TRACE_TEXT_MAX_CHARS`（trace 里存的就是全文）
//
// **读回放一律走 `messages.content`，不要读 `.txt` 当唯一来源。**
// 工具结果的完整原文本来就全量落在 messages（engine 写 tool 消息时原样存），
// 卸载文件只是同一份内容的缓存；它被 prune 掉不等于原文没了。反过来，只看文件在不在
// 就会把"消息还在、只是缓存被清"误报成原文丢失——那是把两件事混成一件。
//
// 判定与 DB/fs 解耦成两层：`replayStateOf` 是纯函数（测试注入 deps），
// `resolveTraceReplay` 才真去问 fs 与 messageRepo。DB 读失败时返回 undefined（判定不可用），
// 不硬凑成三档里的任何一档——"读不出来"不是"已清理"。

import fs from 'node:fs'
import type { AgentTraceRecord, TraceReplayState } from '../../shared/types'
import { defaultOffloadRoot, resolveOffloadPath } from './tool-output-offload'
import { messageRepo } from '../db/repositories/message.repo'
import { createLogger } from '../logger'

const log = createLogger('trace-replay')

export interface TraceReplayDeps {
  /** 卸载文件是否还在（传入的是 `@outputs/...` 这类引用，不是绝对路径） */
  fileExists(ref: string): boolean
  /** `messages` 行是否还在（按 v54 的 messageId） */
  messageExists(messageId: string): boolean
}

/** 行内多调用按换行分隔；保留空段以便与 `messageId` 对齐 */
export function splitTraceRefList(value: string | undefined): string[] {
  if (!value) return []
  return value.split('\n')
}

/**
 * 纯判定：不做 IO，结果不被"文件在但消息没了"糊过去。
 * 任何**结构上对不齐**的记录也判 `expired`——那说明引用记录与调用列表不一致，
 * 我们无法诚实地声称"能回放"。
 */
export function replayStateOf(
  rec: Pick<AgentTraceRecord, 'messageId' | 'coldRef'>,
  deps: TraceReplayDeps
): TraceReplayState {
  const ids = splitTraceRefList(rec.messageId)
  const refs = splitTraceRefList(rec.coldRef)
  // 两列都没值：旧行（v54 之前）或内容从未越过截断上限
  if (ids.length === 0 && refs.length === 0) return 'never_stored'
  // 有引用记录（任一列），但结构不完整 / 对不齐 → 原文已清理
  if (ids.length === 0 || refs.length !== ids.length) return 'expired'
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    const ref = refs[i]
    if (!id || !ref) return 'expired'
    if (!deps.messageExists(id)) return 'expired'
    if (!deps.fileExists(ref)) return 'expired'
  }
  return 'replayable'
}

/**
 * 真实判定：fs + `messages` 现存性。DB/fs 异常时返回 undefined（判定不可用），
 * 调用方不要把它画成任何一档。
 */
export function resolveTraceReplay(rec: AgentTraceRecord): TraceReplayState | undefined {
  try {
    const root = defaultOffloadRoot()
    return replayStateOf(rec, {
      fileExists: (ref) => {
        try {
          return fs.existsSync(resolveOffloadPath(root, ref))
        } catch {
          return false // 非法/越界引用一律按"不在"处理
        }
      },
      messageExists: (messageId) => messageRepo.getById(messageId) !== null
    })
  } catch (e) {
    log.warn(`trace 回放判定失败（按不可用处理）: ${(e as Error).message}`)
    return undefined
  }
}

/** 给一批 trace 记录附上 `replay`；判定不可用的行保持不附（渲染层据此知道"没判过"） */
export function annotateTraceReplay(records: AgentTraceRecord[]): AgentTraceRecord[] {
  return records.map((rec) => {
    const replay = resolveTraceReplay(rec)
    return replay ? { ...rec, replay } : rec
  })
}
