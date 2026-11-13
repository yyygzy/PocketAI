// P0-5 dry-run 回放：工具禁用作用域（回放执行的第一道闸）
//
// 为什么是作用域而不是全局开关：回放与用户正在跑的 Agent 可能同时存在，
// 全局布尔一旦忘记复位（回放抛错／进程退出路径）就会把整台机器的工具一起关掉。
// `AsyncLocalStorage` 只把「禁用」限定在回放自己的异步调用链里，
// 作用域外的 `toolRegistry.execute` 行为完全不变。
//
// 这一层只负责**工具执行**。回放本身不调工具；这道闸是纵深防御——
// 将来若有续跑／单步重试复用回放链路，忘了绕开工具也不会真的写盘。
import { AsyncLocalStorage } from 'node:async_hooks'

/** 被拒时的稳定前缀：调用方与测试按它认，不按错误文案认 */
export const DRY_RUN_TOOL_BLOCKED = 'DRY_RUN_TOOL_BLOCKED'

export interface DryRunScopeState {
  /** 回放期间被拦下的工具执行尝试数；正常情况下恒为 0 */
  blockedAttempts: number
  /** 被拦下的工具名（按尝试顺序；诊断用） */
  blockedTools: string[]
}

const storage = new AsyncLocalStorage<DryRunScopeState>()

/** 当前异步链是否处于回放作用域内 */
export function isDryRunActive(): boolean {
  return storage.getStore() !== undefined
}

/** 当前回放作用域的状态；作用域外返回 undefined */
export function getDryRunScope(): DryRunScopeState | undefined {
  return storage.getStore()
}

/**
 * 工具执行收口的前置断言：回放作用域内一律抛错。
 *
 * 刻意抛错而不是返回 `{isError:true}`：后者会被引擎当成"这个工具失败了"继续走，
 * 等于把一次本不该发生的执行悄悄抹平；抛错才会在回放报告里留下 `blockedAttempts`。
 */
export function assertToolExecutionAllowed(toolName: string): void {
  const state = storage.getStore()
  if (!state) return
  state.blockedAttempts++
  state.blockedTools.push(toolName)
  throw new Error(`${DRY_RUN_TOOL_BLOCKED}:回放期间不执行工具（${toolName}）`)
}

/** 在「工具禁用」作用域内跑一段异步逻辑；回调拿到的 state 用于回放收尾核对 */
export function runWithToolsDisabled<T>(
  fn: (state: DryRunScopeState) => Promise<T>
): Promise<T> {
  const state: DryRunScopeState = { blockedAttempts: 0, blockedTools: [] }
  return storage.run(state, () => fn(state))
}
