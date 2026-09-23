// IPC handler 统一收口：替代每个 handler 里重复的
//   try { ... return { ok: true, ... } } catch (e) { return { ok: false, error: (e as Error).message } }
// 1) 抛出的异常统一转结构化失败，避免未处理 rejection 穿透到渲染层；
// 2) 主进程侧补 warn 日志（原样板全部静默，排障无痕迹）；
// 3) catch 的 unknown 经 instanceof 收窄，不再用 (e as Error).message 不安全断言。
// 注意：仅适用于「整个 handler 体即一个 try」的场景。带回滚、降级返回（如 []）、
// 定制错误前缀或多步事务的 handler 仍需手写 catch，可用 errMsg() 收窄异常文本。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createLogger } from '../logger'
import { errMsg } from '../error'

// 兼容既有 handler 的导入路径（errMsg 实现已移至中性模块 main/error.ts）
export { errMsg }

const log = createLogger('ipc')

export interface IpcFail {
  ok: false
  error: string
}

type InvokeHandler<A extends unknown[]> = (event: IpcMainInvokeEvent, ...args: A) => unknown

/**
 * 注册 IPC handler 并自动兜底：成功原样返回（含业务侧的 { ok:false,error } 校验失败），
 * 抛异常时记日志并返回 { ok:false,error }。
 */
export function safeHandle<A extends unknown[]>(channel: string, listener: InvokeHandler<A>): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      // IPC 边界：electron 给的是 unknown[]，参数类型由各注册点的 listener 签名约束
      return await listener(event, ...(args as unknown as A))
    } catch (e) {
      log.warn(`${channel} 失败:`, e instanceof Error ? e.message : e)
      return { ok: false as const, error: errMsg(e) } satisfies IpcFail
    }
  })
}
