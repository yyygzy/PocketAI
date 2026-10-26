// 渲染层后台 IPC 调用的错误诊断收口
//
// 背景：挂载期/后台刷新类 window.pocketai.* 调用多为 fire-and-forget，
// reject 时只会产生 unhandled promise rejection（仅 DevTools 可见），
// UI 停在空态/loading 且没有任何线索。统一用本工具记诊断日志。
//
// 边界：用户主动触发的操作（保存/生成/导入等）不要用本工具吞错——
// 应在调用处 try/catch 后给 toast 或内联错误反馈。

/**
 * safeHandle 把 handler 抛出的异常转成 `{ ok:false, error }` **返回值**（不是 reject），
 * 所以「返回记录的通道」（saveProvider / saveMcpServer 等）必须显式判别失败，
 * 否则失败对象会被当成记录使用：表单照常关闭、列表里多出一条库里并不存在的记录。
 * 成功返回的记录类型都不含 ok 字段，故 `'ok' in v` 即可判定。
 */
export function isIpcFail(v: unknown): v is { ok: false; error: string } {
  return typeof v === 'object' && v !== null && 'ok' in v
}

/**
 * 只认 `ok === false` 的判别。**有些通道成功时也带 ok**——
 * `KB_DOC_DELETE` / `KB_DOC_SET_ENABLED` / 问答会话那几条都 `return { ok: true }`，
 * 对它们用 isIpcFail 会把成功读成失败（V4-Iter-139 由真桥层用例照出来）。
 * 拿不准就用这个：它只在"明确说了失败"时才成立。
 */
export function hasIpcFailed(v: unknown): v is { ok: false; error?: string } {
  return typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false
}

/** 失败对象的错误文本（缺省时回落到通用文案） */
export function ipcFailText(v: { error?: string }, fallback: string): string {
  return v.error || fallback
}

/**
 * 主进程回码 → 四语 key 的**唯一**登记表（V4-Iter-206 起；208 补进 GLOSSARY_TERM_EMPTY）。
 * main 侧的形状是 `CODE:中文说明`（沿用 BUDGET_EXCEEDED 已有的写法）：
 * 中文尾段留给日志与 IM 回复面，界面**只认回码**，否则英/日/韩界面会夹一句中文。
 * 新增回码必须同时在这里登记，否则 `chat-failure-codes-206.test.ts` 的双向对账闸门会红。
 */
export const IPC_FAIL_TEXT_KEYS: Record<string, string> = {
  CHAT_NO_TARGET: 'chat.errNoTarget',
  CHAT_MSG_NOT_ASSISTANT: 'chat.errMsgNotAssistant',
  CHAT_MSG_NOT_USER: 'chat.errMsgNotUser',
  GLOSSARY_TERM_EMPTY: 'translate.glossaryTermEmpty',
  // 插队赶在运行结束之后（V4-Iter-238）：那句中文留给日志，界面只说"没被收下、还在条上"
  RUN_NOT_FOUND: 'agent.interjectRunEnded',
  // 评测那一趟的三道入口闸（V4-Iter-242）：都是"现在不能开这一趟"，不是"跑坏了"
  EVAL_ALREADY_RUNNING: 'agent.eval.alreadyRunning',
  EVAL_RUN_BUSY: 'agent.eval.busy',
  EVAL_REPORT_NOT_FOUND: 'agent.eval.reportMissing',
  // 「还原到写入前」那一族的五条拒绝（V4-Iter-242 真机撞出来的：它们原本是光秃秃的码，
  // 既躲过了§206 那道闸门，也让界面只能把码原样贴给用户）
  SNAPSHOT_ID_INVALID: 'agent.fsWrite.errIdInvalid',
  SNAPSHOT_NOT_FOUND: 'agent.fsWrite.errNotFound',
  SNAPSHOT_CONSUMED: 'agent.fsWrite.errConsumed',
  SNAPSHOT_DIVERGED: 'agent.fsWrite.errDiverged',
  CURRENT_NOT_TEXT: 'agent.fsWrite.errNotText'
}

/**
 * `safeHandle` 入参校验失败对象上那两个可选字段（主进程 `argFail()` 产出）。
 * **拼进 `error` 是不行的**：渲染层有 137 处 `toast.error(…)`、21 处 `ipcFailText(…)` 直接显示这根串，
 * 走本文件翻译的只有 4 个调用点（chat 三条链／Agent／浮窗／术语表，共 6 条链）。
 * 把回码塞进 `error` 会让这 158 个显示点（两类有重叠）从中文退化成 `IPC_ARG_INVALID:…` —— 那是净倒退。
 * 所以回码独立成字段：走翻译的调用点读它，其余调用点照旧只看 `error`。
 */
const ARG_CODE = 'IPC_ARG_INVALID'
export type IpcFailureInput = string | { error?: string; ipcCode?: string; ipcArgs?: string }

/** `too_small|array` 这类「code:origin」→ 句式 key；主进程只对这三种 origin 编码 */
const ARG_SHAPE_KEYS: Record<string, string> = {
  'too_small|string': 'ipc.argTooSmallChar',
  'too_small|number': 'ipc.argTooSmallNumber',
  'too_small|array': 'ipc.argTooSmallItems',
  'too_big|string': 'ipc.argTooBigChar',
  'too_big|number': 'ipc.argTooBigNumber',
  'too_big|array': 'ipc.argTooBigItems'
}

/** 主进程 ISSUE_FIELD_LABELS 里有的字段名（清单由 `ipc-arg-invalid-209.test.ts` 双向对账） */
const ARG_FIELD_KEYS = new Set([
  'name',
  'title',
  'type',
  'baseUrl',
  'url',
  'apiKeys',
  'models',
  'model',
  'text',
  'content',
  'path',
  'id',
  'enabled',
  'question',
  'history'
])

type Translator = (key: string, params?: Record<string, string | number>) => string

/**
 * `ipcArgs=<path=code=origin=bound>|…` → 四语。
 * 任何解析不出来的形状（没见过的 code／origin、字段名不在清单里…）**一律回落到 `error` 那句中文**：
 * 宁可夹一句中文，也不能把用户的报错解析成半截话或空串。
 */
function argInvalidText(spec: string, tail: string, t: Translator): string {
  const out: string[] = []
  for (const token of spec.split('|')) {
    const [path, code, origin, bound] = token.split('=')
    if (!path || !code) return tail
    const field = path === '?' ? t('ipc.argUnnamed') : ARG_FIELD_KEYS.has(path) ? t(`ipc.field.${path}`) : path
    if (code === 'too_small' || code === 'too_big') {
      const key = ARG_SHAPE_KEYS[`${code}|${origin ?? ''}`]
      if (!key) return tail
      out.push(t(key, { field, n: bound ?? '' }))
    } else if (code === 'invalid_type') {
      out.push(t('ipc.argType', { field, expected: bound ?? '' }))
    } else if (code === 'invalid_format') {
      out.push(t('ipc.argFormat', { field }))
    } else {
      return tail
    }
  }
  return out.join('；')
}

/**
 * 失败对象／回码串 → 界面文案。登记过的回码换四语，没登记的**原样透出**
 * （provider／网络的报错不翻译，也不许咽掉）。入参给对象时读 `ipcCode`/`ipcArgs`，
 * 给字符串时只认 `CODE:说明` 那种形状——两条路都解析不出来就显示 `error`。
 */
export function ipcFailureText(msg: IpcFailureInput, t: Translator): string {
  const text = typeof msg === 'string' ? msg : msg.error ?? ''
  if (typeof msg !== 'string' && msg.ipcCode === ARG_CODE && msg.ipcArgs) {
    return argInvalidText(msg.ipcArgs, text, t)
  }
  const code = /^([A-Z][A-Z0-9_]*):/.exec(text)?.[1]
  const key = code ? IPC_FAIL_TEXT_KEYS[code] : undefined
  return key ? t(key) : text
}

/**
 * chat 发起类通道（send／regenerate／resend，Agent 与 Popup 同源）的失败文案。
 * 预算硬阻断回码带 scope 与金额，单独换 `usage.budgetBlocked`；其余走通用登记表。
 * 回码只从这条链来：`assertBudget()` 在 send/regenerate/resend 的同步段抛出，
 * 被 safeHandle 转成返回值（流式期的 CHAT_ERROR_EVENT 是 provider 报错，不带这些标记）。
 */
export function chatSendFailureText(
  msg: IpcFailureInput,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const text = typeof msg === 'string' ? msg : msg.error ?? ''
  const m = text.match(/^BUDGET_EXCEEDED:(daily|monthly):([\d.]+)/)
  if (m) {
    const scope = m[1] === 'daily' ? t('usage.budgetDaily') : t('usage.budgetMonthly')
    return t('usage.budgetBlocked', { scope, limit: m[2]! })
  }
  return ipcFailureText(msg, t)
}

/** 直接记录一条后台 IPC 失败诊断（try/catch 语句内使用） */
export function logIpcError(label: string, e: unknown): void {
  console.warn(`[ipc] ${label} 失败:`, e instanceof Error ? e.message : e)
}

/** Promise 链版本：可直接传给 .catch()，如 .catch(reportIpcError('listProviders')) */
export const reportIpcError =
  (label: string) =>
  (e: unknown): void =>
    logIpcError(label, e)
