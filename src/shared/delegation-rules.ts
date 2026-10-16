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

/** model 参数长度上限（与文本协议键的单个片段上限同量级；模型名实测远小于此） */
export const DELEGATE_MODEL_MAX_CHARS = 128

/**
 * 写进 schema 的候选模型条数上限。这只是**给模型的提示**，放行与否由主进程对着 provider
 * 表判定（`resolveChildTarget`），所以截断不会让合法值被拒；截断的理由是清单本身要进每一轮请求的
 * tools 载荷 —— 一次上百个模型名是纯 token 开销（见 agent-token-cost 台账那条静态开销实测）。
 */
export const DELEGATE_MODEL_ENUM_MAX_ITEMS = 40

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

export type DelegateArgs =
  | { ok: true; role: DelegateRole; task: string; model: string | null }
  | { ok: false; error: string }

/**
 * 参数校验。**不许在这里做"宽容纠正"**（比如角色写错就默认给 researcher）：
 * 派错人比派失败更难发现——父代理会以为"研究做完了"，而实际跑的是另一个人设。
 * 同理 `model` 在这里**只校验形状、不校验合法性**（这台 provider 到底有没有这个模型，
 * 是主进程 `resolveChildTarget` 对着表判的事）：这里宽容接受非法名字不等于放行，
 * 但在这里查表会让纯规则模块碰库，正是 144 分家要避免的那条。
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
  // model 省略 = 沿用父的端点与模型（144 的形态，今天唯一放得开的形态）
  const rawModel = args.model
  if (rawModel !== undefined && rawModel !== null && rawModel !== '') {
    if (typeof rawModel !== 'string') {
      return { ok: false, error: 'model 必须是字符串（形如 "qwen2.5:3b-instruct" 或 "providerId::模型名"）' }
    }
    const model = rawModel.trim()
    if (model.length > DELEGATE_MODEL_MAX_CHARS) {
      return { ok: false, error: `model 超过 ${DELEGATE_MODEL_MAX_CHARS} 字上限（当前 ${model.length}）` }
    }
    return { ok: true, role, task, model }
  }
  return { ok: true, role, task, model: null }
}

/**
 * 界面标签用的**宽容**读取：不是委派、JSON 非法、role 不在三值内 ⇒ null（不显示标签）。
 * 与 `parseDelegateArgs` 的严格刻意相反：那一份要给模型纠错话，必须报错；这一份只是
 * 告诉用户"这一步派的是谁"，把模型写的原始字符串搬上界面等于渲染不可信内容，
 * 所以只认 `DELEGATE_ROLES` 这三值、其余一律当作"没有可说的"。
 * 为什么从参数里现读而不新增事件字段：`toolCall.function.arguments` 在**live 事件与历史加载
 * 两条路上都已经在**（`toAgentMessages` 从 DB tool 消息里还原 arguments），加字段就得给
 * agent_traces 迁移一列，而一步里可能有两条委派（145 的并行形态）——一列装不下。
 */
export function readDelegateRoleForDisplay(
  toolName: string | undefined,
  argsJson: string | undefined
): DelegateRole | null {
  if (toolName !== DELEGATE_TOOL_NAME) return null
  let raw: unknown
  try {
    raw = JSON.parse(argsJson ?? '') as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const role = (raw as Record<string, unknown>).role
  return isDelegateRole(role) ? role : null
}

/** 委派工具面里代表"会走 embedding 检索链"的那把工具（名字逐字等于 kb-search.ts 的 schema.name） */
export const KB_SEARCH_TOOL_NAME = 'kb_search'

/**
 * 「这条编排会不会走 embedding 检索链」——145 跨模型角色的第二条合取的唯一算法。
 * 刻意只认这两件事（助手绑了知识库 / 工具面里有 kb_search），**不做任何显存算术**：
 * 判据的理由是 M10 实测"一个 embed 进来把对话模型顶出去"，不是"放不下"。
 * 引擎筛工具面时与 146 的判据屏调的是同一个函数——两处各写一份迟早会漂。
 */
export function surfaceUsesRetrieval(tools: ReadonlyArray<{ name: string }>, kbIds: ReadonlyArray<string>): boolean {
  return kbIds.length > 0 || tools.some((t) => t.name === KB_SEARCH_TOOL_NAME)
}

export interface DelegateToolLike {
  name: string
  permission?: 'auto' | 'confirm' | 'deny'
}

/** schema 交换所需的最小形状（`ToolSchema` 的这三项；不 import 类型是为了保住本模块的零依赖） */
export interface DelegateModelSchemaLike {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * 把 `delegate_task` 的 schema 换成"带 model 参数"的那一份（V4-Iter-145，**只在容量判据放行跨模型角色时**调用）。
 * 三条刻意的做法：
 *  · **返回浅拷贝，绝不原地改**：传进来的是注册表里那个对象引用，原地加一个键就会污染所有
 *    没开跨模型角色的会话——那是 118 那族"看不见的共享状态"的形状。
 *  · `enum` 只是**给模型的提示**：放行与否由主进程对着 provider 表判（`resolveChildTarget`），
 *    所以超出上限被截断的模型名仍可能被合法使用，而 enum 里的名字也不会因此被当成保证。
 *  · 原 `parameters` 的 `additionalProperties: false` 一并保留：新键必须显式进 properties。
 */
export function withDelegateModelParam<T extends DelegateModelSchemaLike>(tool: T, modelOptions: string[]): T {
  const options = modelOptions.slice(0, DELEGATE_MODEL_ENUM_MAX_ITEMS)
  const parameters = { ...(tool.parameters ?? {}) }
  const properties = { ...((parameters.properties as Record<string, unknown> | undefined) ?? {}) }
  properties.model = {
    type: 'string',
    ...(options.length > 0 ? { enum: options } : {}),
    description:
      '可选：让这个角色用另一台模型跑。省略就沿用你现在的模型。' +
      (options.length > 0
        ? `可选值：${options.join(' / ')}${modelOptions.length > options.length ? `（另有 ${modelOptions.length - options.length} 个未列出，仍可原样填写）` : ''}`
        : '形如 "模型名" 或 "providerId::模型名"')
  }
  parameters.properties = properties
  return {
    ...tool,
    description:
      tool.description +
      ' 需要让某个角色用别的模型时，在 model 里填模型名；不确定就留空（留空=沿用当前模型）。',
    parameters
  }
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
