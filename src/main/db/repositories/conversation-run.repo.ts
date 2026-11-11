// v60：`conversation_runs` 运行态持久化（B-3 / D4）。
//
// 与 `conversations.status` 的分工（D7）：这一列只回答「这次 run 怎么结束的」，
// 一行一个 requestId；`conversations.status` 已停写（v60 起运行态只认本表 + 内存注册表）。
//
// 写入方只有主进程运行态注册表（runtime-registry）：内存是事实来源，本仓储只做落地。
// 启动时由 `interruptActive()` 把上一进程残留的 running/pending_approval 标成 interrupted。
//
// v66 起这一行还记「跑到哪」：`stage` / `steps_done` / `tool_steps_done` 由运行中的
// `checkpoint()` 逐步写入；`resume_state` 只在启动对账时写下（这次中断能不能接着跑）。
// 两件事刻意分开：前者是事实，后者是**对这份事实的判定**，判定不回头改事实。
//
// 测试里很多模块会 import 引擎/聊天服务但没有真库（dbService 未 open）：
// 持久化是旁路，不能因为「没有库」把一次 run 打挂——未开库时静默跳过（内存注册表照常工作）。
import { dbService } from '../database'
import type { ChatRunResume, ChatRunStage } from '../../../shared/types'

export type ConversationRunMode = 'chat' | 'agent'
export type ConversationRunStatus =
  | 'running'
  | 'pending_approval'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted'

export interface ConversationRunSeed {
  requestId: string
  conversationId: string
  mode: ConversationRunMode
  startedAt: number
}

/** v66：一次逐步检查点（只写在运行中的行上，终态行不回头改） */
export interface ConversationRunCheckpoint {
  stage: ChatRunStage
  /** 已走完的步数（当前这一步之前的边界） */
  stepsDone: number
  /** 已经进入过几次工具步（>0 ⇒ 可能已有副作用，不能判"可继续"） */
  toolStepsDone: number
}

export interface InterruptedRunRow extends ConversationRunSeed {
  status: ConversationRunStatus
  /** 老记录没有检查点 ⇒ null（不编造阶段） */
  stage: ChatRunStage | null
  stepsDone: number | null
  toolStepsDone: number | null
  /** 启动对账写下的判定，随行一起返回给注册表 */
  resumeState: ChatRunResume
}

/**
 * 「这次中断能不能接着跑」的唯一判据。
 * - 没有检查点（v66 之前的老行 / 还没写过一步）⇒ 沿用 v60 语义：只能重来；
 * - 进过工具步 ⇒ 工具可能已经执行过，没有幂等就不能假设它没发生 ⇒ 只能重来；
 * - 停在工具步/审批/收尾 ⇒ 正在做的事没有完成 ⇒ 只能重来；
 * - 只剩 preparing/model：模型调用没有副作用，停在边界上可以从头再发一次。
 */
export function judgeRunResume(input: {
  stage: ChatRunStage | null
  toolStepsDone: number | null
}): ChatRunResume {
  if (!input.stage) return 'restart'
  if ((input.toolStepsDone ?? 0) > 0) return 'restart'
  if (input.stage === 'tools' || input.stage === 'approval' || input.stage === 'final') return 'restart'
  return 'resumable'
}

export const conversationRunRepo = {
  /** run 开始：插入 running 行；requestId 已存在时按最新一次覆盖（同一 run 不会重复 start） */
  start(run: ConversationRunSeed): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `INSERT OR REPLACE INTO conversation_runs
           (request_id, conversation_id, mode, status, started_at, ended_at, error_code,
            stage, steps_done, tool_steps_done, resume_state)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, 'preparing', 0, 0, NULL)`
      )
      .run(run.requestId, run.conversationId, run.mode, run.startedAt)
  },

  /**
   * 逐步检查点：只改事实列，不动 status/started_at；终态行不覆盖。
   * 写库失败不让 run 挂掉（调用方在引擎热路径上，持久化是旁路）。
   */
  checkpoint(requestId: string, cp: ConversationRunCheckpoint): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `UPDATE conversation_runs
         SET stage=?, steps_done=?, tool_steps_done=?
         WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')`
      )
      .run(cp.stage, cp.stepsDone, cp.toolStepsDone, requestId)
  },

  /** 运行中状态迁移（running ↔ pending_approval）；不动 started_at */
  setStatus(requestId: string, status: 'running' | 'pending_approval'): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare("UPDATE conversation_runs SET status=? WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')")
      .run(status, requestId)
  },

  /** 终态：写 status + ended_at（+ 可选错误码）；已终态的行不覆盖。中断的判定在 interruptActive 里写 */
  finish(
    requestId: string,
    status: 'done' | 'failed' | 'aborted' | 'interrupted',
    errorCode?: string | null
  ): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `UPDATE conversation_runs
         SET status=?, ended_at=?, error_code=?
         WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')`
      )
      .run(status, Date.now(), errorCode ?? null, requestId)
  },

  /**
   * 启动对账：把上一进程遗留的 running/pending_approval 标为 interrupted，
   * 并按检查点写下 `resume_state`（可继续 / 只能重来）。
   * 返回被改到的行（注册表据此给侧栏一次「已中断」提示，并带上判定）。
   * 幂等：第二次调用命中 0 行，也不会重写已有判定。
   */
  interruptActive(): InterruptedRunRow[] {
    if (!dbService.isOpen()) return []
    const db = dbService.getHandle()
    const rows = db
      .prepare(
        `SELECT request_id AS requestId, conversation_id AS conversationId, mode,
                status, started_at AS startedAt,
                stage, steps_done AS stepsDone, tool_steps_done AS toolStepsDone
         FROM conversation_runs
         WHERE status IN ('running','pending_approval')`
      )
      .all() as Array<Omit<InterruptedRunRow, 'resumeState'>>
    if (rows.length === 0) return []
    const update = db.prepare(
      `UPDATE conversation_runs
       SET status='interrupted', ended_at=?, resume_state=?
       WHERE request_id=? AND status IN ('running','pending_approval')`
    )
    const now = Date.now()
    const out: InterruptedRunRow[] = []
    for (const row of rows) {
      const resumeState = judgeRunResume({ stage: row.stage, toolStepsDone: row.toolStepsDone })
      update.run(now, resumeState, row.requestId)
      out.push({ ...row, resumeState })
    }
    return out
  },

  /** 删除会话时级联删除该会话的全部 run 行 */
  deleteByConversation(conversationId: string): void {
    if (!dbService.isOpen()) return
    dbService.getHandle().prepare('DELETE FROM conversation_runs WHERE conversation_id=?').run(conversationId)
  }
}
