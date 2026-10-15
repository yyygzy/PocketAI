// 委派的纯规则（V4-Iter-144）——零依赖，所以住在 shared
//
// 为什么与 `src/main/agent/delegation.ts` 分家（这条不是洁癖，是刚踩出来的）：
// 建子会话那部分要用 `conversationRepo` → `dbService` → `portable` → `electron`，
// 而**工具注册表也要用这里的常量**（`tools/delegate-tool.ts`）。两者放一个文件里，
// 等于让所有引用内置工具的测试顺带把整条 electron 链拉起来 ——
// `builtin-tools.test.ts` / `builtin-safematheval.test.ts` 就是这么当场红的（`app.isPackaged` undefined）。
// 与 V4-Iter-123 同一条纪律：**纯函数的家要中立**，别让宿主模块带着副作用。
//
// 规则本身的出处（都不是推理）：
//  · 默认关 + 用户点名（决策③，2026-10-15）；
//  · 子代理独立会话、角色归会话（决策②）；
//  · 预算 3 角色 × 5 步 = 15 次 LLM 调用（M7 热态 1.34s/次、142 一次探测 3 发实测 8.5–18.4s）；
//  · 子清单摘掉委派本身与 confirm/deny 类（M7：无人值守下撞确认只会回一句"请在桌面端操作"，
//    用户既看不到弹窗也没拿到结果）。

/** 工具名（给模型看的函数名，须匹配 ^[a-zA-Z][a-zA-Z0-9_]*$）与注册 id */
export const DELEGATE_TOOL_NAME = 'delegate_task'
export const DELEGATE_TOOL_ID = 'agent.delegate'

/** 三个角色就是方案 §144 的"帽子"，不是可无限扩展的枚举：预算按角色数算，多一个角色就多一份耗时 */
export const DELEGATE_ROLES = ['researcher', 'writer', 'reviewer'] as const
export type DelegateRole = (typeof DELEGATE_ROLES)[number]

export function isDelegateRole(v: unknown): v is DelegateRole {
  return typeof v === 'string' && (DELEGATE_ROLES as readonly string[]).includes(v)
}

/** 任务描述上限：委派不是"把整篇文档塞过去"，超上限直接拒（截断会让子代理答非所问） */
export const DELEGATE_TASK_MAX_CHARS = 4000

/**
 * 一轮编排的 LLM 调用总数上限：**3 角色 × 5 步 = 15**。
 * 本机 4GiB 实测下来这已是"最坏 ≥20 秒、带冷启动更多"的量级；再高就成了用户看不见的长时间占用。
 */
export const DELEGATION_MAX_LLM_CALLS = 15

/** 一轮编排最多开几条子会话（父可以在预算内换角色再派，但不许无限派） */
export const DELEGATION_MAX_CHILDREN = 3

/** 每个角色的开场白：只交代身份与交付形态，不给它读父上下文的权力（子会话天生隔离） */
export const ROLE_BRIEF: Record<DelegateRole, string> = {
  researcher:
    '你是资料检索子代理。只用给到的工具取证，产出"结论 + 依据条目"的清单，不要写正文、不要抒情。' +
    '证据不足时明确说缺什么，不要编。',
  writer: '你是撰稿子代理。依据给到的材料与要点写符合任务要求的正文；不要复述任务，不要声明你调用了什么工具。',
  reviewer: '你是审校子代理。指出事实、逻辑与表述上的问题，逐条给"问题 + 建议改法"；没有问题就明确说没有。'
}

/** 整棵编排树共享的预算（按引用传递：子 run 消费同一个对象） */
export interface RunBudget {
  used: number
  max: number
  children: number
  maxChildren: number
}

export function newRunBudget(): RunBudget {
  return { used: 0, max: DELEGATION_MAX_LLM_CALLS, children: 0, maxChildren: DELEGATION_MAX_CHILDREN }
}

/** 预算是否已见底（用 `>=`：触顶那一轮不该再发出去） */
export function budgetExhausted(b: RunBudget): boolean {
  return b.used >= b.max
}

/** 还能不能再开一条子会话 */
export function canOpenChild(b: RunBudget): boolean {
  return b.children < b.maxChildren
}

export type DelegateArgs = { ok: true; role: DelegateRole; task: string } | { ok: false; error: string }

/**
 * 参数校验。**不许在这里做"宽容纠正"**（比如角色写错就默认给 researcher）：
 * 派错人比派失败更难发现——父代理会以为"研究做完了"，而实际跑的是另一个人设。
 */
export function parseDelegateArgs(args: Record<string, unknown>): DelegateArgs {
  const role = args.role
  if (!isDelegateRole(role)) {
    return { ok: false, error: `role 必须是 ${DELEGATE_ROLES.join(' / ')} 之一（收到 ${JSON.stringify(role)}）` }
  }
  const raw = args.task
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { ok: false, error: 'task 必须是非空字符串：说清要什么、给谁看、交付形态' }
  }
  const task = raw.trim()
  if (task.length > DELEGATE_TASK_MAX_CHARS) {
    return { ok: false, error: `task 超过 ${DELEGATE_TASK_MAX_CHARS} 字上限（当前 ${task.length}）` }
  }
  return { ok: true, role, task }
}

export interface DelegateToolLike {
  name: string
  permission?: 'auto' | 'confirm' | 'deny'
}

/**
 * 子级工具面 = 父级**看得见**的工具面 减去 委派本身 减去 需要人工确认/被禁的工具。
 * 入参是父 run 已按助手权限筛好的面 ⇒ "子级授权 ⊆ 父级"是结构性成立的，
 * 不需要再读一遍助手的 tool_permissions（那会是第二个判定点，两处迟早漂移）。
 */
export function childToolSurface<T extends DelegateToolLike>(parentTools: T[]): T[] {
  return parentTools.filter((t) => t.name !== DELEGATE_TOOL_NAME && t.permission !== 'confirm' && t.permission !== 'deny')
}

/** 回给父上下文的工具结果头部（分步明细里一眼看出这是子代理的产出，不是工具原文） */
export function formatDelegationResult(input: { role: DelegateRole; childConversationId: string; content: string }): string {
  return `【子代理 ${input.role} 的回答（独立会话 ${input.childConversationId.slice(0, 8)}）】\n${input.content}`
}
