// Agent 评测的**跨进程形状**（V4-Iter-242）。
//
// 为什么这份文件在 shared 而不是留在 `main/agent/eval/`：评测的结果要在界面上读
// （进度、报告、逐发的会话 id），而界面拿到的必须是同一份类型——把类型抄一份到渲染层
// 就是 §153 那条"文案手抄会漂"的老病换个字段重犯。
//
// 两个数字不是便利常量，是口径：
//  · `AGENT_EVAL_MAX_K` 卡在 5 而不是 50：检索评测一发是毫秒级，Agent 一发是十几秒到几十秒，
//    k 直接乘在**用户的额度与等待时间**上（真机那一趟实测见台账 §242）。
//  · 默认 k=2：`pass^k` 要求跑满 k 次全过，k=1 时它跟 pass@1 是同一个数，报两个字段就是自欺。
/** 插话那一发的现场事实：`asked`＝任务要求插一句，`accepted`＝正在跑的那轮把它收进了收件箱 */
export interface AgentEvalInterjectionFact {
  asked: boolean
  accepted: boolean
  text: string
}

export type AgentEvalTier = 'smoke' | 'full'

export const AGENT_EVAL_DEFAULT_K = 2
export const AGENT_EVAL_MAX_K = 5

/**
 * 一次尝试的结果。`ran=false` 与"跑了但没过"是两档，混在一起第一批数字就是把接线问题算成模型问题
 * （这条口径来自 §233，字段搬到这儿是因为界面要分颜色说这两件事）。
 */
export interface AgentEvalAttemptOutcome {
  ran: boolean
  pass: boolean
  steps?: number
  why?: string
}

/** 一发的现场：除了判分结果，还带着**这一发的会话 id 与工作目录**（用户选定：产物留着、报告里写 id） */
export interface AgentEvalAttempt extends AgentEvalAttemptOutcome {
  taskId: string
  /** 第几次尝试，1 起 */
  attempt: number
  tier: AgentEvalTier
  conversationId: string
  assistantId: string
  requestId: string
  workspaceDir: string
  approvals: number
  tokens?: number
  /** 这一发有没有插话、插的那句被运行收下了没有（没插话时是 undefined，不是"插了没收到"） */
  interjection?: AgentEvalInterjectionFact
}

/** 逐发进度（评测一跑就是几分钟到几十分钟，没有这一栏界面就只能干等，等成"看起来卡死"） */
export interface AgentEvalProgressEvent {
  runId: string
  tier: AgentEvalTier
  model: string
  providerId: string
  /** 这一发开跑前一共要跑多少发（tasks × k） */
  total: number
  /** 已经跑完的发数 */
  done: number
  phase: 'attempt-start' | 'attempt-done' | 'stopped'
  current?: { taskId: string; attempt: number }
  attempt?: AgentEvalAttempt
}

export interface AgentEvalRunResult {
  runId: string
  providerId: string
  model: string
  tier: AgentEvalTier
  k: number
  startedAt: number
  elapsedMs: number
  /** 被打断过：报告里 `reliable` 那个数就不能和跑满的那趟并排比 */
  interrupted: boolean
  /** 跑完时有没有被用户喊停（true=至少有一发没开跑） */
  stoppedEarly: boolean
  attempts: AgentEvalAttempt[]
  report: AgentEvalSuiteReport
  reportPath: string
  reportText: string
}

/** 一个任务的聚合 */
export interface AgentEvalTaskReport {
  id: string
  tier: AgentEvalTier
  attempts: number
  passed: number
  /** 至少一次跑起来的尝试里，通过的比例 */
  passAt1: number
  /** k 次全过 ⇒ 1；有任何一次没过 ⇒ 0 */
  passAllK: number
  notRan: number
  maxSteps?: number
  /** 超步数的那几次（"绕了很久终于对"要能被单独看见，不能算成通过） */
  stepOverruns: number
  reasons: string[]
}

export interface AgentEvalSuiteReport {
  perTask: AgentEvalTaskReport[]
  tasks: number
  k: number
  /** 全过（passAllK=1）的任务数：这才是"可靠性"那一个数 */
  reliable: number
  /** 至少一次通过的任务数：与上一行并列报，别只报好看的那个 */
  everPassed: number
  /** 一次都没跑起来的任务数（环境/接线坏了，与"模型不行"是两件事） */
  deadTasks: number
}

/** 落盘报告的目录清单条目（"上次跑的那趟"要能重开，否则每次点开界面都得再花一遍额度） */
export interface AgentEvalReportEntry {
  fileName: string
  mtimeMs: number
  /** 报告第一行（`Agent 评测：4 个任务 × 每任务 2 次`），列表里就靠它认这是哪一趟 */
  firstLine: string
}
