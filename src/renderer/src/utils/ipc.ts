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
 * chat 发起类通道（send／regenerate／resend，Agent 与 Popup 同源）的失败文案。
 * 预算硬阻断在 main 侧抛的是带标记的错误串（`BUDGET_EXCEEDED:scope:limit:` 后跟中文原文），
 * 这里只取前面的回码，按 scope 换四语专门文案——后面的中文不进界面。
 * 回码只从这条链来：`assertBudget()` 在 send/regenerate/resend 的同步段抛出，
 * 被 safeHandle 转成返回值（流式期的 CHAT_ERROR_EVENT 是 provider 报错，不带这个标记）。
 */
export function chatSendFailureText(
  msg: string,
  t: (key: string, params?: Record<string, string | number>) => string
): string {
  const m = msg.match(/^BUDGET_EXCEEDED:(daily|monthly):([\d.]+):/)
  if (!m) return msg
  const scope = m[1] === 'daily' ? t('usage.budgetDaily') : t('usage.budgetMonthly')
  return t('usage.budgetBlocked', { scope, limit: m[2]! })
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
