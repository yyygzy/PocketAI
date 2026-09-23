// 渲染层后台 IPC 调用的错误诊断收口
//
// 背景：挂载期/后台刷新类 window.pocketai.* 调用多为 fire-and-forget，
// reject 时只会产生 unhandled promise rejection（仅 DevTools 可见），
// UI 停在空态/loading 且没有任何线索。统一用本工具记诊断日志。
//
// 边界：用户主动触发的操作（保存/生成/导入等）不要用本工具吞错——
// 应在调用处 try/catch 后给 toast 或内联错误反馈。

/** 直接记录一条后台 IPC 失败诊断（try/catch 语句内使用） */
export function logIpcError(label: string, e: unknown): void {
  console.warn(`[ipc] ${label} 失败:`, e instanceof Error ? e.message : e)
}

/** Promise 链版本：可直接传给 .catch()，如 .catch(reportIpcError('listProviders')) */
export const reportIpcError =
  (label: string) =>
  (e: unknown): void =>
    logIpcError(label, e)
