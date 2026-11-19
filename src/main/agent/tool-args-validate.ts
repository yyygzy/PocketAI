// 工具参数执行前校验（v78 第 4 批）
//
// 现状缺口：`tc.function.arguments` 解析失败会被静默当成 `{}`（engine 里做安全策略预览时如此），
// 真正执行时工具只会回一句"xxx 不能为空"——线上模型拿不到"哪个字段不对、应该是什么类型"，
// 只能靠猜再试一次。这里在**执行前**做一次轻量校验，把结构化错误作为工具结果回注给模型，
// 模型据此可以自行修正（是否重试仍由模型决定，重复调用另有 MAX_REPEAT_TOOL_CALLS 兜底）。
//
// 刻意只校验 JSON 合法性、必填项与顶层类型：不实现完整 JSON Schema（工具自身仍做业务校验），
// 也不对未知/缺省字段扩大限制——宁可漏报，不能把原本能跑通的调用挡在门外。
import type { ToolSchema } from '../../shared/types'

export interface ToolArgsValidation {
  ok: boolean
  /** 不合法时的可回注文案（含"怎么修"的提示） */
  error?: string
}

interface JsonSchemaLike {
  type?: string
  properties?: Record<string, { type?: string }>
  required?: string[]
}

function typeLabel(type: string | undefined): string {
  return type ? type : '值'
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    default:
      return true // 不认识的类型（enum/oneOf 等）不做限制
  }
}

/** 校验工具参数；schema 缺失时只校验 JSON 形态 */
export function validateToolArguments(
  schema: ToolSchema | null | undefined,
  argsJson: string
): ToolArgsValidation {
  const raw = String(argsJson ?? '').trim()
  let parsed: unknown = {}
  if (raw) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return {
        ok: false,
        error: '参数校验失败：arguments 不是合法 JSON。请按工具 schema 输出 JSON 对象后重新调用。'
      }
    }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      error: '参数校验失败：arguments 必须是 JSON 对象（不能是数组或标量）。请修正后重新调用。'
    }
  }
  const params = schema?.parameters as JsonSchemaLike | undefined
  if (!params) return { ok: true }

  const args = parsed as Record<string, unknown>
  for (const key of params.required ?? []) {
    const v = args[key]
    // 必填字符串全空白也按缺失处理：下游工具只会回"xx 不能为空"，不如在这里一次说清楚
    const blank = typeof v === 'string' && v.trim() === ''
    if (v === undefined || v === null || blank) {
      const t = params.properties?.[key]?.type
      return {
        ok: false,
        error: `参数校验失败：缺少必填参数 ${key}（${typeLabel(t)}）。请按工具 schema 补齐后重新调用。`
      }
    }
  }
  for (const [key, def] of Object.entries(params.properties ?? {})) {
    const v = args[key]
    if (v === undefined) continue
    if (!def?.type || matchesType(v, def.type)) continue
    return {
      ok: false,
      error: `参数校验失败：${key} 必须是 ${def.type}，收到 ${Array.isArray(v) ? 'array' : typeof v}。请修正后重新调用。`
    }
  }
  return { ok: true }
}
