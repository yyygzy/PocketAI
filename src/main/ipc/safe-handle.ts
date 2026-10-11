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
 * 常见字段名 → 中文标签。映射不到的**原样显示 key**（不猜、不编中文名），
 * 因为猜错标签比显示英文 key 更容易误导用户。
 */
const ISSUE_FIELD_LABELS: Record<string, string> = {
  name: '名称',
  title: '标题',
  type: '类型',
  baseUrl: 'Base URL',
  url: '地址',
  apiKeys: 'API Key',
  models: '模型',
  model: '模型',
  text: '文本',
  content: '内容',
  path: '路径',
  id: 'ID',
  enabled: '启用开关'
}

function fieldLabel(path: (string | number)[]): string {
  const key = path.filter((p) => typeof p === 'string').join('.')
  if (!key) return '参数'
  return ISSUE_FIELD_LABELS[key] ?? key
}

/**
 * zod issue → 一句中文。
 * schema 里已经写过自定义文案（含非 ASCII 字符，例如「文本不能为空」）的原样保留；
 * 只有 zod 默认英文文案才翻译。未知 code 回落到「不符合要求」而不是把英文甩给用户。
 */
export function describeIssue(issue: z.ZodIssue): string {
  const msg = issue.message ?? ''
  if (/[^\x00-\x7F]/.test(msg)) return msg
  const label = fieldLabel(issue.path as (string | number)[])
  switch (issue.code) {
    case 'too_small':
      return issue.origin === 'array'
        ? `${label}至少需要 ${issue.minimum} 项`
        : issue.origin === 'number'
          ? `${label}不能小于 ${issue.minimum}`
          : `${label}至少需要 ${issue.minimum} 个字符`
    case 'too_big':
      return issue.origin === 'array'
        ? `${label}最多 ${issue.maximum} 项`
        : issue.origin === 'number'
          ? `${label}不能大于 ${issue.maximum}`
          : `${label}过长，最多 ${issue.maximum} 个字符`
    case 'invalid_type':
      return `${label}类型不对（应为 ${issue.expected}）`
    case 'invalid_value': {
      // 枚举/字面量取值不合法（zod v4 的 code 是 invalid_value，v3 才叫 invalid_enum_value）
      const values = (issue as { values?: unknown[] }).values
      return Array.isArray(values) && values.length > 0
        ? `${label}取值不在允许范围内（可选：${values.join(' / ')}）`
        : `${label}取值不在允许范围内`
    }
    case 'unrecognized_keys':
      return `包含不认识的字段：${issue.keys.join(', ')}`
    case 'invalid_format':
      // z.url()/z.email() 这类格式校验：默认文案是整句英文，只留字段名与「格式不正确」
      return `${label}格式不正确`
    default:
      return `${label}不符合要求`
  }
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
          // 日志留 path + code + 英文原文（排障要看真因），返回给界面的翻译成人话
          const raw = result.error.issues
            .map((i) => `${i.path.join('.') || '?'}: ${i.code} ${i.message}`)
            .join('; ')
          log.warn(`${channel} 入参校验失败: ${raw}`)
          const friendly = result.error.issues.map(describeIssue).join('；')
          return { ok: false as const, error: friendly } satisfies IpcFail
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
