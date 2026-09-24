// IPC handler 统一收口：替代每个 handler 里重复的
//   try { ... return { ok: true, ... } } catch (e) { return { ok: false, error: (e as Error).message } }
// 1) 抛出的异常统一转结构化失败，避免未处理 rejection 穿透到渲染层；
// 2) 主进程侧补 warn 日志（原样板全部静默，排障无痕迹）；
// 3) catch 的 unknown 经 instanceof 收窄，不再用 (e as Error).message 不安全断言。
// 注意：仅适用于「整个 handler 体即一个 try」的场景。带回滚、降级返回（如 []）、
// 定制错误前缀或多步事务的 handler 仍需手写 catch，可用 errMsg() 收窄异常文本。
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { z, type ZodTuple } from 'zod'
import { createLogger } from '../logger'
import { errMsg } from '../error'

// 兼容既有 handler 的导入路径（errMsg 实现已移至中性模块 main/error.ts）
export { errMsg }
// 导出 z 供各 handler 直接构造基本类型 schema（如 z.string()）
export { z }

const log = createLogger('ipc')

export interface IpcFail {
  ok: false
  error: string
}

type InvokeHandler<A extends unknown[]> = (event: IpcMainInvokeEvent, ...args: A) => unknown

/**
 * 入参 schema 工厂：大部分 IPC 通道是固定位置参数，用 z.tuple([...]) 描述。
 * 例：argsSchema(z.string(), z.number()) 对应 (_e, a: string, b: number)
 */
export function argsSchema<T extends [z.ZodTypeAny, ...z.ZodTypeAny[]]>(...items: T): ZodTuple<T> {
  return z.tuple(items)
}

/**
 * 注册 IPC handler 并自动兜底：
 * 1) 若提供 argsSchema，先用 zod 校验位置参数，失败记 warn 并返回结构化错误，
 *    防止畸形/恶意参数穿透到主进程业务逻辑（纵深防御）；
 * 2) 成功原样返回（含业务侧的 { ok:false,error } 校验失败）；
 * 3) 抛异常时记日志并返回 { ok:false,error }。
 */
export function safeHandle<A extends unknown[]>(
  channel: string,
  listener: InvokeHandler<A>,
  argsSchema?: ZodTuple
): void {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    try {
      let validated: unknown[] = args
      if (argsSchema) {
        const result = argsSchema.safeParse(args)
        if (!result.success) {
          const issues = result.error.issues.map((i) => i.message).join('; ')
          log.warn(`${channel} 入参校验失败: ${issues}`)
          return { ok: false as const, error: `invalid args: ${issues}` } satisfies IpcFail
        }
        validated = result.data
      }
      // IPC 边界：electron 给的是 unknown[]，参数类型由各注册点的 listener 签名约束
      return await listener(event, ...(validated as unknown as A))
    } catch (e) {
      log.warn(`${channel} 失败:`, e instanceof Error ? e.message : e)
      return { ok: false as const, error: errMsg(e) } satisfies IpcFail
    }
  })
}
