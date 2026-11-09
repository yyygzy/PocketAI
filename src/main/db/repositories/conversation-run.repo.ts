// v60：`conversation_runs` 运行态持久化（B-3 / D4）。
//
// 与 `conversations.status` 的分工（D7）：这一列只回答「这次 run 怎么结束的」，
// 一行一个 requestId；`conversations.status` 仍继续写，但界面不再读它。
//
// 写入方只有主进程运行态注册表（runtime-registry）：内存是事实来源，本仓储只做落地。
// 启动时由 `interruptActive()` 把上一进程残留的 running/pending_approval 标成 interrupted。
//
// 测试里很多模块会 import 引擎/聊天服务但没有真库（dbService 未 open）：
// 持久化是旁路，不能因为「没有库」把一次 run 打挂——未开库时静默跳过（内存注册表照常工作）。
import { dbService } from '../database'

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

export interface InterruptedRunRow extends ConversationRunSeed {
  status: ConversationRunStatus
}

export const conversationRunRepo = {
  /** run 开始：插入 running 行；requestId 已存在时按最新一次覆盖（同一 run 不会重复 start） */
  start(run: ConversationRunSeed): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `INSERT OR REPLACE INTO conversation_runs
           (request_id, conversation_id, mode, status, started_at, ended_at, error_code)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL)`
      )
      .run(run.requestId, run.conversationId, run.mode, run.startedAt)
  },

  /** 运行中状态迁移（running ↔ pending_approval）；不动 started_at */
  setStatus(requestId: string, status: 'running' | 'pending_approval'): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare("UPDATE conversation_runs SET status=? WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')")
      .run(status, requestId)
  },

  /** 终态：写 status + ended_at（+ 可选错误码）；已终态的行不覆盖 */
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
   * 启动对账：把上一进程遗留的 running/pending_approval 标为 interrupted。
   * 返回被改到的行（注册表据此给侧栏一次「已中断」提示）。
   * 幂等：第二次调用命中 0 行。
   */
  interruptActive(): InterruptedRunRow[] {
    if (!dbService.isOpen()) return []
    const db = dbService.getHandle()
    const rows = db
      .prepare(
        `SELECT request_id AS requestId, conversation_id AS conversationId, mode,
                status, started_at AS startedAt
         FROM conversation_runs
         WHERE status IN ('running','pending_approval')`
      )
      .all() as InterruptedRunRow[]
    if (rows.length === 0) return []
    db.prepare(
      `UPDATE conversation_runs
       SET status='interrupted', ended_at=?
       WHERE status IN ('running','pending_approval')`
    ).run(Date.now())
    return rows
  },

  /** 删除会话时级联删除该会话的全部 run 行 */
  deleteByConversation(conversationId: string): void {
    if (!dbService.isOpen()) return
    dbService.getHandle().prepare('DELETE FROM conversation_runs WHERE conversation_id=?').run(conversationId)
  }
}
