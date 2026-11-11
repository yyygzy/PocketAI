// 模型输出的结构化契约层
//
// 把「模型正文」当成不可信外部输入：先提取 JSON，再用 zod 校验；校验失败只给模型
// 一次修复机会，仍不合格就把「哪一段不合规」如实交回调用方，绝不把坏内容当合法数据
// 往下传。
//
// 与工具参数 BAD_ARGS 的关系：
//   BAD_ARGS 是「调用工具的参数 JSON 解析失败」的专用富文本错误，引擎会识别
//   `[BAD_ARGS]` 前缀并追加「重新调用该工具」的修正引导。这里复用它的
//   「稳定 code + 原始片段 + 可读定位」形态，但**不复用前缀**：模型正文没有
//   「重新调用工具」这回事，混用前缀会让引擎给出错误引导。
//
// 错误分级：
//   stage=UNPARSEABLE  文本里提取不出 JSON（模型没按格式输出 / 返回空）
//   stage=SCHEMA       JSON 能解析，但 zod 判定不合规
//   issue.code=MISSING_FIELD  必填字段缺失（该路径的值为 undefined）
//   issue.code=INVALID_FIELD  字段类型/范围/枚举不合法，或出现 schema 未声明的字段
//
// schema 如何表达两种语义：
//   「允许缺失」          → z.string().optional() / .nullish() / .default()
//   「不允许编造」        → z.strictObject() / z.object().strict()：未知字段会以
//                          unrecognized_keys 报 INVALID_FIELD，而不是被静默丢弃。
//   不使用 .strict() 的 schema 表示「多余字段无害，直接忽略」——由调用方按消费面选择。
import { z } from 'zod'
import { errMsg } from '../error'

export type StructuredOutputIssueCode = 'MISSING_FIELD' | 'INVALID_FIELD'
export type StructuredOutputStage = 'UNPARSEABLE' | 'SCHEMA'

export interface StructuredOutputIssue {
  code: StructuredOutputIssueCode
  /** 可读定位，例如 `queries[0].title`；根节点为 `(root)` */
  path: string
  message: string
}

export interface StructuredOutputError {
  code: 'BAD_OUTPUT'
  stage: StructuredOutputStage
  issues: StructuredOutputIssue[]
  /** 最近一次模型原文（按 maxRawChars 截断），供调用方写日志或构造修复 prompt */
  raw: string
  /** 仅 stage=UNPARSEABLE：提取失败的具体原因 */
  parseError?: string
}

export type StructuredOutputResult<T> =
  | { ok: true; data: T; attempts: 1 | 2; raw: string }
  | {
      ok: false
      error: StructuredOutputError
      attempts: 1 | 2
      /** 最近一次拿到的原文（修复轮抛错时是首轮原文） */
      raw: string
      /** 修复轮自身抛错（网络/超时）时的错误文本；此时 error 仍是首轮校验错误 */
      repairError?: string
    }

export interface GenerateStructuredOptions<T> {
  schema: z.ZodType<T>
  /**
   * 首轮传入 null；校验失败后的修复轮传入首轮错误（含 raw 与 issues），
   * 由调用方决定怎么把「哪里不合规」写进 prompt。
   * 首轮抛错会原样抛给调用方（属于调用失败，不是输出不合规）；
   * 修复轮抛错会被捕获并写进 repairError。
   */
  generate: (repair: StructuredOutputError | null) => Promise<string>
  /** 错误里保留的模型原文上限，默认 500。修复 prompt 用的也是这份截断文本。 */
  maxRawChars?: number
}

const DEFAULT_MAX_RAW_CHARS = 500

/**
 * 生成并校验结构化输出。最多调用 generate 两次（首轮 + 一次修复），绝不循环。
 */
export async function generateStructured<T>(
  opts: GenerateStructuredOptions<T>
): Promise<StructuredOutputResult<T>> {
  const maxRawChars = opts.maxRawChars ?? DEFAULT_MAX_RAW_CHARS

  // 首轮异常属于「模型调用失败」，不是「输出不合规」：交给调用方按原有降级路径处理
  const firstRaw = await opts.generate(null)
  const first = evaluate(firstRaw, opts.schema, maxRawChars)
  if (first.ok) {
    return { ok: true, data: first.data, attempts: 1, raw: capRaw(firstRaw, maxRawChars) }
  }

  // 修复只有一次：这里不写循环，第二发之后无论结果如何都返回
  try {
    const secondRaw = await opts.generate(first.error)
    const second = evaluate(secondRaw, opts.schema, maxRawChars)
    if (second.ok) {
      return { ok: true, data: second.data, attempts: 2, raw: capRaw(secondRaw, maxRawChars) }
    }
    return { ok: false, error: second.error, attempts: 2, raw: capRaw(secondRaw, maxRawChars) }
  } catch (e) {
    return {
      ok: false,
      error: first.error,
      attempts: 2,
      raw: capRaw(firstRaw, maxRawChars),
      repairError: errMsg(e)
    }
  }
}

/** 把结构化错误压成一行可读文本：带 stage、路径与字段缺失/非法的区分。 */
export function describeStructuredError(error: StructuredOutputError): string {
  const stage =
    error.stage === 'UNPARSEABLE' ? '无法从模型输出中提取 JSON' : 'JSON 结构不符合 schema'
  if (error.issues.length === 0) {
    return `[BAD_OUTPUT] ${stage}${error.parseError ? `：${error.parseError}` : ''}`
  }
  const shown = error.issues.slice(0, 3)
  const detail = shown
    .map((issue) =>
      issue.code === 'MISSING_FIELD'
        ? `${issue.path} 缺少必填字段`
        : `${issue.path} 字段非法（${issue.message}）`
    )
    .join('；')
  const more = error.issues.length > shown.length ? `；等 ${error.issues.length} 项` : ''
  return `[BAD_OUTPUT] ${stage}：${detail}${more}`
}

export type ExtractedJson =
  | { ok: true; value: unknown }
  | { ok: false; detail: string }

/**
 * 从模型文本中提取第一个可解析的 JSON 值。依次尝试：
 *   1. 整段直接 parse；
 *   2. markdown 代码块（```json / ```）；
 *   3. 从 `{` 或 `[` 起的括号平衡扫描（忽略字符串内的括号与转义）。
 */
export function extractJson(text: string): ExtractedJson {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, detail: '模型返回空文本' }

  const direct = tryParse(raw)
  if (direct.ok) return direct

  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/g
  for (const match of raw.matchAll(fence)) {
    const inner = match[1]?.trim()
    if (!inner) continue
    const parsed = tryParse(inner)
    if (parsed.ok) return parsed
    const balanced = scanBalanced(inner)
    if (balanced.ok) return balanced
  }

  return scanBalanced(raw)
}

function evaluate<T>(
  text: string,
  schema: z.ZodType<T>,
  maxRawChars: number
): { ok: true; data: T } | { ok: false; error: StructuredOutputError } {
  const raw = capRaw(text, maxRawChars)
  const extracted = extractJson(text)
  if (!extracted.ok) {
    return {
      ok: false,
      error: {
        code: 'BAD_OUTPUT',
        stage: 'UNPARSEABLE',
        issues: [],
        raw,
        parseError: extracted.detail
      }
    }
  }

  const parsed = schema.safeParse(extracted.value)
  if (parsed.success) return { ok: true, data: parsed.data }
  return {
    ok: false,
    error: {
      code: 'BAD_OUTPUT',
      stage: 'SCHEMA',
      issues: mapIssues(parsed.error, extracted.value),
      raw
    }
  }
}

function tryParse(text: string): ExtractedJson {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : 'JSON 解析失败' }
  }
}

/** 从每一个 `{` / `[` 起点尝试括号平衡提取，第一个能 parse 的胜出。 */
function scanBalanced(text: string): ExtractedJson {
  let lastDetail = '未找到 JSON 对象或数组'
  for (let start = 0; start < text.length; start++) {
    const ch = text.charAt(start)
    if (ch !== '{' && ch !== '[') continue
    const result = tryBalancedFrom(text, start)
    if (result.ok) return result
    lastDetail = result.detail
  }
  return { ok: false, detail: lastDetail }
}

function tryBalancedFrom(text: string, start: number): ExtractedJson {
  const open = text.charAt(start)
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text.charAt(i)
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === open) {
      depth++
    } else if (ch === close) {
      depth--
      if (depth === 0) return tryParse(text.slice(start, i + 1))
    }
  }
  return { ok: false, detail: 'JSON 括号未闭合' }
}

function mapIssues(error: z.ZodError, root: unknown): StructuredOutputIssue[] {
  const issues: StructuredOutputIssue[] = []
  for (const issue of error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        issues.push({
          code: 'INVALID_FIELD',
          path: formatPath([...issue.path, key]),
          message: `schema 未声明的字段「${key}」`
        })
      }
      continue
    }

    const missing = valueAtPath(root, issue.path) === undefined
    issues.push({
      code: missing ? 'MISSING_FIELD' : 'INVALID_FIELD',
      path: formatPath(issue.path),
      message: missing ? '必填字段缺失' : issue.message
    })
  }
  return issues
}

function valueAtPath(root: unknown, path: readonly PropertyKey[]): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<PropertyKey, unknown>)[key]
  }
  return cur
}

function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '(root)'
  let out = ''
  for (const seg of path) {
    if (typeof seg === 'number') {
      out += `[${seg}]`
    } else {
      const key = String(seg)
      out += out ? `.${key}` : key
    }
  }
  return out
}

function capRaw(text: string, maxChars: number): string {
  const raw = String(text ?? '')
  if (raw.length <= maxChars) return raw
  return `${raw.slice(0, maxChars)}…（截断，原文共 ${raw.length} 字符）`
}
