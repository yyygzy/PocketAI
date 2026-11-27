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
import { resolveSharedPath, serializeSharedPath } from '../../portable-paths'
import type { ChatRunResume, ChatRunStage, ToolCall } from '../../../shared/types'

export type ConversationRunMode = 'chat' | 'agent'
export type ConversationRunStatus =
  | 'running'
  | 'pending_approval'
  | 'done'
  | 'failed'
  | 'aborted'
  | 'interrupted'

/** 起点快照里的 workspace_dir 也要跟着共享数据根走 */
function resolveRunRow<T extends { workspaceDir?: string | null }>(row: T): T {
  return { ...row, workspaceDir: resolveSharedPath(row.workspaceDir ?? null) ?? undefined }
}

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
  /** v75：本轮有效工具集快照（JSON）；NULL＝旧口径，续跑按当前助手签名比对 */
  toolScopeJson?: string | null
  /** v81：起点工作目录内容指纹（JSON）；NULL＝老 run 只比路径，degraded 也照写以 fail-closed */
  workspaceFingerprintJson?: string | null
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
  /** v75：与 sig 同一句写入，避免出现「有签名没范围」或反过来的半截状态 */
  toolScopeJson?: string | null
  /** v81：内容指纹只在第一次写入，后续 COALESCE 保住 */
  workspaceFingerprintJson?: string | null
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
  toolScopeJson: string | null
  /** v81：起点内容指纹；NULL＝老 run（继续走路径口径） */
  workspaceFingerprintJson: string | null
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
  /** v75：per-run 授权快照；NULL＝旧 run（续跑走当前助手签名口径） */
  toolScopeJson: string | null
  /** v81：起点内容指纹；NULL＝老 run（续跑只比路径） */
  workspaceFingerprintJson: string | null
}

/**
 * 「这次中断/失败能不能接着跑」的唯一判据。
 * - 普通对话（mode='chat'）没有续跑入口 ⇒ 只能重来（文案说"需重新开始"才是实话）；
 * - 没有检查点 / 没有锚点（v73 之前的老行）⇒ 不猜，只能重来；
 * - 停在审批/收尾 ⇒ 正在做的事没有完成 ⇒ 只能重来；
 * - **完成判定只认产物**：assistant 是否 done、它的每个 tool_call 是否都有 done 的 tool 应答。
 *   不认 `tool_steps_done`（那一列写在执行之前，含义是"进过工具步"，不是"做完"）。
 *   有未应答的 tool_call ⇒ 半截批次，已执行的副作用不可知 ⇒ 只能重来（P1-3b）。
 * - 完成步数 = doneAssistants + settledToolSteps，必须与检查点对齐：
 *   · 停在 model/preparing ⇒ 等于 steps_done（检查点写在下一步之前）；
 *   · 停在 tools 且工具步已全部落库 ⇒ 等于 steps_done + 1（检查点写在工具步之前）。
 *   对齐不能省：进程可能倒在「模型已答完、下一步检查点还没写」的窗口里。
 * - P1-3c：`status='failed'` 只允许停在 model 的一档按步重试（失败步 = steps_done + 1）；
 *   工具/审批/收尾里失败一律重来。
 */
export function judgeRunResume(input: {
  mode?: ConversationRunMode
  stage: ChatRunStage | null
  stepsDone?: number | null
  toolStepsDone: number | null
  anchorUserMessageId?: string | null
  /**
   * P1-3c：这次判定针对的 run 状态。`failed` 只允许「停在模型步」这一档按步重试；
   * 工具/审批/收尾里失败说明脚下的事实没走完，只能重来。省略＝按 interrupted 的老口径。
   */
  status?: 'interrupted' | 'failed' | null
  /** 该锚点下已落库（status='done'）的 assistant 条数；undefined＝不校验（只给老调用方/纯函数单测） */
  doneAssistantCount?: number | null
  /** 该锚点下已落库的 tool 条数；undefined＝不校验 */
  toolMessageCount?: number | null
  /**
   * P1-3b：已完整落库的工具步数（assistant 带 tool_calls，且每个 call 都有 done 的 tool 应答）。
   * 与下面两项一起给齐时，判定改用「完成步数 = doneAssistants + settledToolSteps」的精确口径；
   * 不给则退回旧口径（一次工具都不许碰）——老调用方与纯函数单测的行为不变。
   */
  settledToolSteps?: number | null
  /** P1-3b：尚未被 tool 消息应答的 tool_call 数；>0 ⇒ 半截批次，副作用不可知，绝不续跑 */
  danglingToolCalls?: number | null
}): ChatRunResume {
  if (input.mode !== undefined && input.mode !== 'agent') return 'restart'
  if (!input.stage) return 'restart'
  if (!input.anchorUserMessageId) return 'restart'
  // P1-3c：失败落在工具步/审批/收尾里 ⇒ 不做「按步重试」
  if (input.status === 'failed' && input.stage !== 'model') return 'restart'
  if (input.stage === 'approval' || input.stage === 'final') return 'restart'

  // ── 精确口径（P1-3b）：有逐步产物事实时，只按事实对齐 ─────────────────────
  if (input.doneAssistantCount != null && input.settledToolSteps != null && input.danglingToolCalls != null) {
    if (input.stepsDone == null) return 'restart'
    // 有 tool 消息却没有任何一步 "全部应答"，要么是半截批次，要么是来路不明的工具消息
    if (input.danglingToolCalls > 0) return 'restart'
    if ((input.toolMessageCount ?? 0) > 0 && input.settledToolSteps === 0) return 'restart'
    // 进过的工具步必须每一步都有"全部应答"的证据。多出来的只可能是重复拦截（没执行）
    // 或半截批次（执行到一半），两者都不该按步续跑。
    if ((input.toolStepsDone ?? 0) !== input.settledToolSteps) return 'restart'
    const completed = input.doneAssistantCount + input.settledToolSteps
    if (input.stage === 'tools') {
      // 检查点写在步前：工具步已经全部落库、而「下一步」的检查点还没写 ⇒ 完成步数比 steps_done 多 1
      return completed === input.stepsDone + 1 ? 'resumable' : 'restart'
    }
    return completed === input.stepsDone ? 'resumable' : 'restart'
  }

  // ── 旧口径（没有逐步产物事实）：一次工具都不许碰 ──────────────────────────
  if ((input.toolStepsDone ?? 0) > 0) return 'restart'
  if (input.stage === 'tools') return 'restart'
  if ((input.toolMessageCount ?? 0) > 0) return 'restart'
  if (input.doneAssistantCount != null) {
    if (input.stepsDone == null) return 'restart'
    if (input.doneAssistantCount !== input.stepsDone) return 'restart'
  }
  return 'resumable'
}

/** 锚点下与"步是否真的走完"有关的事实（续跑准入用，P1-3b） */
export interface AnchorStepFacts {
  /** 该锚点下已落库（status='done'）的 assistant 条数 */
  doneAssistants: number
  /** 该锚点下已落库（status='done'）的 tool 条数 */
  toolMessages: number
  /** 已完整落库的工具步数（assistant 的每个 tool_call 都有 done 的 tool 应答） */
  settledToolSteps: number
  /** 尚未被 tool 消息应答的 tool_call 数；>0 ⇒ 半截批次 */
  danglingToolCalls: number
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
            anchor_user_message_id, workspace_dir, tool_permissions_sig, tool_scope_json,
            workspace_fingerprint_json)
         VALUES (?, ?, ?, 'running', ?, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
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
        serializeSharedPath(run.workspaceDir ?? null),
        run.toolPermissionsSig ?? null,
        run.toolScopeJson ?? null,
        run.workspaceFingerprintJson ?? null
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
             tool_permissions_sig=COALESCE(?, tool_permissions_sig),
             tool_scope_json=COALESCE(?, tool_scope_json),
             workspace_fingerprint_json=COALESCE(?, workspace_fingerprint_json)
         WHERE request_id=? AND status NOT IN ('done','failed','aborted','interrupted')`
      )
      .run(
        cp.stage,
        cp.stepsDone,
        cp.toolStepsDone,
        serializeSharedPath(cp.workspaceDir ?? null),
        cp.toolPermissionsSig ?? null,
        cp.toolScopeJson ?? null,
        cp.workspaceFingerprintJson ?? null,
        requestId
      )
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
                workspace_dir AS workspaceDir, tool_permissions_sig AS toolPermissionsSig,
                tool_scope_json AS toolScopeJson,
                workspace_fingerprint_json AS workspaceFingerprintJson
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
    const now = Date.now()
    const out: InterruptedRunRow[] = []
    for (const row of rows) {
      // 判定要对着**已落库的事实**：没有锚点就没法数，交给 judge 判 restart（不猜）
      const facts: AnchorStepFacts | null = row.anchorUserMessageId
        ? this.scanAnchorSteps(row.anchorUserMessageId)
        : null
      const resumeState = judgeRunResume({
        mode: row.mode,
        stage: row.stage,
        stepsDone: row.stepsDone,
        toolStepsDone: row.toolStepsDone,
        anchorUserMessageId: row.anchorUserMessageId,
        doneAssistantCount: facts?.doneAssistants ?? null,
        toolMessageCount: facts?.toolMessages ?? null,
        settledToolSteps: facts?.settledToolSteps,
        danglingToolCalls: facts?.danglingToolCalls
      })
      update.run(now, resumeState, row.requestId)
      out.push(resolveRunRow({ ...row, resumeState }))
    }
    return out
  },

  /**
   * 按 requestId 取一条 run（P1-5 生成流程模板时判定"这次 run 成功结束了吗"）。
   * 与 `getLatest` 同一个快照形状，一字不差；读不到返回 null（老库/被清理的行）。
   */
  getByRequest(requestId: string): ConversationRunSnapshot | null {
    if (!dbService.isOpen()) return null
    const row = dbService
      .getHandle()
      .prepare(
        `SELECT request_id AS requestId, conversation_id AS conversationId, mode, status,
                started_at AS startedAt, ended_at AS endedAt,
                stage, steps_done AS stepsDone, tool_steps_done AS toolStepsDone,
                resume_state AS resumeState,
                anchor_user_message_id AS anchorUserMessageId,
                workspace_dir AS workspaceDir, tool_permissions_sig AS toolPermissionsSig,
                tool_scope_json AS toolScopeJson,
                workspace_fingerprint_json AS workspaceFingerprintJson
         FROM conversation_runs
         WHERE request_id=?`
      )
      .get(requestId) as ConversationRunSnapshot | undefined
    return row ? resolveRunRow(row) : null
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
                workspace_dir AS workspaceDir, tool_permissions_sig AS toolPermissionsSig,
                tool_scope_json AS toolScopeJson,
                workspace_fingerprint_json AS workspaceFingerprintJson
         FROM conversation_runs
         WHERE conversation_id=?
         ORDER BY started_at DESC
         LIMIT 1`
      )
      .get(conversationId) as ConversationRunSnapshot | undefined
    return row ? resolveRunRow(row) : null
  },

  /**
   * 锚点下的逐步产物事实（续跑准入用，P1-3b）。
   * 完成判定只认两件事：assistant 是 done、它的每个 tool_call 都有 done 的 tool 应答
   * （应答从 tool 消息 content 里的 `toolCallId` 对上）。**不数 tool_steps_done**——
   * 那一列写在执行之前，含义是"进过工具步"，拿它判"做完"会漏掉半截批次。
   * assistant 只数 `status='done'`：崩溃留下的 streaming 占位已被启动清扫标成 error，不算一步。
   */
  scanAnchorSteps(anchorUserMessageId: string): AnchorStepFacts {
    const empty: AnchorStepFacts = {
      doneAssistants: 0,
      toolMessages: 0,
      settledToolSteps: 0,
      danglingToolCalls: 0
    }
    if (!dbService.isOpen()) return empty
    const db = dbService.getHandle()
    const assistants = db
      .prepare(
        `SELECT id, tool_calls AS toolCalls FROM messages
         WHERE role='assistant' AND status='done' AND parent_id=?
         ORDER BY created_at ASC`
      )
      .all(anchorUserMessageId) as Array<{ id: string; toolCalls: string | null }>
    const toolRows = db
      .prepare(
        `SELECT parent_id AS parentId, content FROM messages
         WHERE role='tool' AND status='done'
           AND parent_id IN (SELECT id FROM messages WHERE role='assistant' AND parent_id=?)`
      )
      .all(anchorUserMessageId) as Array<{ parentId: string; content: string }>

    // 按父 assistant 分组收「已应答的 toolCallId」：跨 assistant 复用同一个 id 的重放数据不该互相顶替
    const answeredByParent = new Map<string, Set<string>>()
    for (const row of toolRows) {
      let callId = ''
      try {
        const parsed = JSON.parse(row.content) as { toolCallId?: unknown }
        callId = typeof parsed?.toolCallId === 'string' ? parsed.toolCallId : ''
      } catch {
        // 老消息格式没有 toolCallId：算一条工具消息，但无法证明确切应答了哪次调用
      }
      if (!callId) continue
      let set = answeredByParent.get(row.parentId)
      if (!set) {
        set = new Set()
        answeredByParent.set(row.parentId, set)
      }
      set.add(callId)
    }

    let settledToolSteps = 0
    let danglingToolCalls = 0
    for (const a of assistants) {
      if (!a.toolCalls) continue
      let calls: ToolCall[] = []
      try {
        const parsed = JSON.parse(a.toolCalls) as unknown
        if (Array.isArray(parsed)) {
          calls = parsed.filter((tc): tc is ToolCall => !!tc && typeof (tc as ToolCall).id === 'string')
        }
      } catch {
        // 坏数据按"没有 tool_calls"处理：它本来也无法被判成完成
        continue
      }
      if (calls.length === 0) continue
      const answered = answeredByParent.get(a.id) ?? new Set<string>()
      const missing = calls.filter((tc) => !answered.has(tc.id)).length
      if (missing === 0) settledToolSteps += 1
      else danglingToolCalls += missing
    }

    return {
      doneAssistants: assistants.length,
      toolMessages: toolRows.length,
      settledToolSteps,
      danglingToolCalls
    }
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
