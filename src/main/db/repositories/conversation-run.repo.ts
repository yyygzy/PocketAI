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
  /**
   * v73：这一轮锚定的用户消息 id。续跑靠它找回上下文（不重复插用户消息、不靠时间戳猜），
   * 启动对账也靠它数「这一步之前已经落库了几条助手消息」。
   */
  anchorUserMessageId?: string | null
  /** v73：起点工作目录快照；续跑时与当前值不一致 ⇒ fail-closed */
  workspaceDir?: string | null
  /** v73：起点工具授权签名快照；续跑时与当前值不一致 ⇒ fail-closed */
  toolPermissionsSig?: string | null
  /** 续跑：接续的断点（不传＝按 preparing / 0 步开始） */
  stage?: ChatRunStage
  stepsDone?: number
  toolStepsDone?: number
}

/** v66：一次逐步检查点（只写在运行中的行上，终态行不回头改） */
export interface ConversationRunCheckpoint {
  stage: ChatRunStage
  /** 已走完的步数（当前这一步之前的边界） */
  stepsDone: number
  /** 已经进入过几次工具步（>0 ⇒ 可能已有副作用，不能判"可继续"） */
  toolStepsDone: number
  /** v73：第一个检查点顺带落起点快照（之后传空，不覆盖已有值） */
  workspaceDir?: string | null
  toolPermissionsSig?: string | null
}

export interface InterruptedRunRow {
  requestId: string
  conversationId: string
  mode: ConversationRunMode
  status: ConversationRunStatus
  startedAt: number
  /** 老记录没有检查点 ⇒ null（不编造阶段） */
  stage: ChatRunStage | null
  stepsDone: number | null
  toolStepsDone: number | null
  anchorUserMessageId: string | null
  workspaceDir: string | null
  toolPermissionsSig: string | null
  /** 启动对账写下的判定，随行一起返回给注册表 */
  resumeState: ChatRunResume
}

/** 最近一条 run 的完整快照（续跑准入从这里读，含 v73 三列） */
export interface ConversationRunSnapshot {
  requestId: string
  conversationId: string
  mode: ConversationRunMode
  status: ConversationRunStatus
  startedAt: number
  endedAt: number | null
  stage: ChatRunStage | null
  stepsDone: number | null
  toolStepsDone: number | null
  resumeState: ChatRunResume | null
  anchorUserMessageId: string | null
  workspaceDir: string | null
  toolPermissionsSig: string | null
}

/**
 * 「这次中断能不能接着跑」的唯一判据（v73 收窄）。
 * - 普通对话（mode='chat'）没有续跑入口 ⇒ 只能重来（文案说"需重新开始"才是实话）；
 * - 没有检查点 / 没有锚点（v73 之前的老行）⇒ 不猜，只能重来；
 * - 进过工具步、或该锚点下已有 tool 消息 ⇒ 工具可能已经执行过，没有幂等就不能假设它没发生 ⇒ 只能重来；
 * - 停在工具步/审批/收尾 ⇒ 正在做的事没有完成 ⇒ 只能重来；
 * - 只在 preparing/model 停下，且**已落库的助手消息条数与 steps_done 对齐**时，才判可继续。
 *   对齐不能省：检查点写在步前，进程可能倒在「模型已答完、下一步检查点还没写」的窗口里；
 *   那时 steps_done 落后一条，照它续跑会重跑已经答完的那一步（步号也会重叠）。
 */
export function judgeRunResume(input: {
  mode?: ConversationRunMode
  stage: ChatRunStage | null
  stepsDone?: number | null
  toolStepsDone: number | null
  anchorUserMessageId?: string | null
  /** 该锚点下已落库（status='done'）的 assistant 条数；undefined＝不校验（只给老调用方/纯函数单测） */
  doneAssistantCount?: number | null
  /** 该锚点下已落库的 tool 条数；undefined＝不校验 */
  toolMessageCount?: number | null
}): ChatRunResume {
  if (input.mode !== undefined && input.mode !== 'agent') return 'restart'
  if (!input.stage) return 'restart'
  if (!input.anchorUserMessageId) return 'restart'
  if ((input.toolStepsDone ?? 0) > 0) return 'restart'
  if (input.stage === 'tools' || input.stage === 'approval' || input.stage === 'final') return 'restart'
  if ((input.toolMessageCount ?? 0) > 0) return 'restart'
  if (input.doneAssistantCount != null) {
    if (input.stepsDone == null) return 'restart'
    if (input.doneAssistantCount !== input.stepsDone) return 'restart'
  }
  return 'resumable'
}

export const conversationRunRepo = {
  /**
   * run 开始：插入 running 行。
   * v73 起带三列起点快照；续跑用的是**新 requestId**，所以正常路径不会撞已有行
   * （旧行保留，中断审计不被覆盖）。真撞上时按最新一次覆盖，与 v60 语义一致。
   */
  start(run: ConversationRunSeed): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `INSERT OR REPLACE INTO conversation_runs
           (request_id, conversation_id, mode, status, started_at, ended_at, error_code,
            stage, steps_done, tool_steps_done, resume_state,
            anchor_user_message_id, workspace_dir, tool_permissions_sig)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?)`
      )
      .run(
        run.requestId,
        run.conversationId,
        run.mode,
        run.startedAt,
        run.stage ?? 'preparing',
        run.stepsDone ?? 0,
        run.toolStepsDone ?? 0,
        run.anchorUserMessageId ?? null,
        run.workspaceDir ?? null,
        run.toolPermissionsSig ?? null
      )
  },

  /**
   * 逐步检查点：只改事实列，不动 status/started_at；终态行不覆盖。
   * 写库失败不让 run 挂掉（调用方在引擎热路径上，持久化是旁路）。
   * v73：起点快照只在第一个检查点带过来，用 COALESCE 保住已有值（后续检查点传空）。
   */
  checkpoint(requestId: string, cp: ConversationRunCheckpoint): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `UPDATE conversation_runs
         SET stage=?, steps_done=?, tool_steps_done=?,
             workspace_dir=COALESCE(?, workspace_dir),
             tool_permissions_sig=COALESCE(?, tool_permissions_sig)
         WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')`
      )
      .run(cp.stage, cp.stepsDone, cp.toolStepsDone, cp.workspaceDir ?? null, cp.toolPermissionsSig ?? null, requestId)
  },

  /**
   * v73：用户消息落库后补锚点。
   * 为什么不在 start 里带：用户消息是在 setup 中段才插入的，start 时还没有它的 id；
   * 补写只改这一列，不动其它事实。
   */
  setAnchor(requestId: string, anchorUserMessageId: string): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare(
        `UPDATE conversation_runs SET anchor_user_message_id=?
         WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')`
      )
      .run(anchorUserMessageId, requestId)
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
                stage, steps_done AS stepsDone, tool_steps_done AS toolStepsDone,
                anchor_user_message_id AS anchorUserMessageId,
                workspace_dir AS workspaceDir, tool_permissions_sig AS toolPermissionsSig
         FROM conversation_runs
         WHERE status IN ('running','pending_approval')
         ORDER BY started_at ASC`
      )
      .all() as Array<Omit<InterruptedRunRow, 'resumeState'>>
    if (rows.length === 0) return []
    const update = db.prepare(
      `UPDATE conversation_runs
       SET status='interrupted', ended_at=?, resume_state=?
       WHERE request_id=? AND status IN ('running','pending_approval')`
    )
    const countDone = db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND status='done' AND parent_id=?"
    )
    const countTools = db.prepare(
      "SELECT COUNT(*) AS n FROM messages WHERE role='tool' AND parent_id IN (SELECT id FROM messages WHERE role='assistant' AND parent_id=?)"
    )
    const now = Date.now()
    const out: InterruptedRunRow[] = []
    for (const row of rows) {
      // 判定要对着**已落库的事实**：没有锚点就没法数，交给 judge 判 restart（不猜）
      let doneAssistantCount: number | null = null
      let toolMessageCount: number | null = null
      if (row.anchorUserMessageId) {
        doneAssistantCount = (countDone.get(row.anchorUserMessageId) as { n: number }).n
        toolMessageCount = (countTools.get(row.anchorUserMessageId) as { n: number }).n
      }
      const resumeState = judgeRunResume({
        mode: row.mode,
        stage: row.stage,
        stepsDone: row.stepsDone,
        toolStepsDone: row.toolStepsDone,
        anchorUserMessageId: row.anchorUserMessageId,
        doneAssistantCount,
        toolMessageCount
      })
      update.run(now, resumeState, row.requestId)
      out.push({ ...row, resumeState })
    }
    return out
  },

  /**
   * 该会话最近一条 run（不分状态）。
   * 续跑只认「最新一条且是 interrupted」——用户崩溃后先发了新消息，就说明这一轮已经被放过了，
   * 不能拿更早的断点再续。
   */
  getLatest(conversationId: string): ConversationRunSnapshot | null {
    if (!dbService.isOpen()) return null
    const row = dbService
      .getHandle()
      .prepare(
        `SELECT request_id AS requestId, conversation_id AS conversationId, mode, status,
                started_at AS startedAt, ended_at AS endedAt,
                stage, steps_done AS stepsDone, tool_steps_done AS toolStepsDone,
                resume_state AS resumeState,
                anchor_user_message_id AS anchorUserMessageId,
                workspace_dir AS workspaceDir, tool_permissions_sig AS toolPermissionsSig
         FROM conversation_runs
         WHERE conversation_id=?
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(conversationId) as ConversationRunSnapshot | undefined
    return row ?? null
  },

  /**
   * 锚点下已落库的产物条数（续跑准入用）。
   * assistant 只数 `status='done'`：崩溃留下的 streaming 占位已被启动清扫标成 error，不算一步。
   */
  countArtifacts(anchorUserMessageId: string): { doneAssistants: number; toolMessages: number } {
    if (!dbService.isOpen()) return { doneAssistants: 0, toolMessages: 0 }
    const db = dbService.getHandle()
    const done = db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE role='assistant' AND status='done' AND parent_id=?")
      .get(anchorUserMessageId) as { n: number }
    const tools = db
      .prepare(
        "SELECT COUNT(*) AS n FROM messages WHERE role='tool' AND parent_id IN (SELECT id FROM messages WHERE role='assistant' AND parent_id=?)"
      )
      .get(anchorUserMessageId) as { n: number }
    return { doneAssistants: done.n, toolMessages: tools.n }
  },

  /** 续跑准入失败后把判定降级成 restart（判定不回头改事实列） */
  markRestart(requestId: string): void {
    if (!dbService.isOpen()) return
    dbService
      .getHandle()
      .prepare("UPDATE conversation_runs SET resume_state='restart' WHERE request_id=? AND status='interrupted'")
      .run(requestId)
  },

  /** 删除会话时级联删除该会话的全部 run 行 */
  deleteByConversation(conversationId: string): void {
    if (!dbService.isOpen()) return
    dbService.getHandle().prepare('DELETE FROM conversation_runs WHERE conversation_id=?').run(conversationId)
  }
}
