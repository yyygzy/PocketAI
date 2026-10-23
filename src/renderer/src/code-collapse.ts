// 长代码块折叠阈值：与 chat-font 同构——主进程只存取（app_config），渲染端缓存并落地行为。
//
// 阈值放在模块级可变快照 + 订阅集合里，Markdown 用 useSyncExternalStore 读取：
// 设置页改完阈值，已挂载的代码块立刻重新判定折叠，不需要重启或翻历史。

import { CODE_COLLAPSE_THRESHOLD } from './utils/code-block'
import { logIpcError } from './utils/ipc'

/** 与主进程 schema 上限保持一致 */
export const MAX_CODE_COLLAPSE_LINES = 200

let threshold = CODE_COLLAPSE_THRESHOLD
const listeners = new Set<() => void>()
let loadError: string | null = null

/** 脏值回落默认 20 行；0 是合法值（永不折叠），负数 / NaN / 非数字才回落 */
export function normalizeCodeCollapseLines(v: unknown): number {
  if (v === null || v === undefined || v === '') return CODE_COLLAPSE_THRESHOLD
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return CODE_COLLAPSE_THRESHOLD
  return Math.min(MAX_CODE_COLLAPSE_LINES, Math.floor(n))
}

/** 当前生效阈值（useSyncExternalStore 的快照函数，必须返回原始值） */
export function codeCollapseLines(): number {
  return threshold
}

/** 覆盖阈值并通知订阅者；值未变化时不通知（避免无谓重渲染） */
export function setCodeCollapseLines(v: unknown): void {
  const next = normalizeCodeCollapseLines(v)
  if (next === threshold) return
  threshold = next
  for (const l of [...listeners]) l()
}

export function subscribeCodeCollapse(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 启动时偏好读取失败时的错误信息（供 App.tsx 展示兜底提示） */
export function getCodeCollapseLoadError(): string | null {
  return loadError
}

/** 启动时拉取偏好（失败静默，沿用常量默认 20 行） */
export async function loadCodeCollapseLines(): Promise<void> {
  try {
    const r = await window.pocketai.getUiPrefs()
    if (r.ok && r.data) {
      setCodeCollapseLines(r.data.codeCollapseLines)
      loadError = null
    } else {
      loadError = r.error ?? 'failed'
    }
  } catch (e) {
    logIpcError('loadCodeCollapseLines', e)
    loadError = String(e)
  }
}
