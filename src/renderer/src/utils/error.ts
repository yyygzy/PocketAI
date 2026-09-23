// catch 子句错误文本收口：catch (e) 的 e 是 unknown，直接 (e as Error).message
// 在 throw '字符串' / throw 非 Error 值时会拿到 undefined，最终给用户看到空错误。
// 与主进程 ipc/safe-handle.ts 的 errMsg 同型，渲染层命名 errText。
// 需要 i18n 兜底文案时传 fallback（如 errText(e, t('common.unknownError'))）。
/** unknown 异常 → 可展示文本：Error 取 message，非空字符串直接用，其余走 fallback */
export function errText(e: unknown, fallback = '未知错误'): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}
