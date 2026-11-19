// 每台模型「上下文窗口」这一个输入的边界（V4-Iter-234）
//
// 放在 shared 是因为两侧都要用同一把尺子：主进程拿它拒绝脏值，渲染层拿它做输入前的校验
// 和那句"这个数不行"里的数字——数字抄进字典迟早和代码漂移（§153 那条"按钮名不再手抄"同一根轴）。
// 键的形状 `providerId::model` 沿用模型级开关那一族（文本协议、委派授权）。

/** 下限：低于这个数的"窗口"跑不动 Agent（单步静态开销实测在 3.8k 量级），只可能是填错 */
export const MODEL_WINDOW_MIN_TOKENS = 512

/** 上限：防脏值把 app_config 撑大，也挡住"手滑多打两个 0" */
export const MODEL_WINDOW_MAX_TOKENS = 4_000_000

/** 条目上限：一个实例里被点名过的模型不会多，超限只防脏值 */
export const MODEL_WINDOW_MAX_ENTRIES = 200

/**
 * 没声明窗口时每轮带的条数（引擎那侧的 MAX_CONTEXT_MESSAGES 用它，界面那句"留空按最近的 N 条走"
 * 也用它）。这个数字出现在文案里，就不要在两处各写一遍——§153 那条"按钮名不再手抄"同一根轴。
 */
export const DEFAULT_MESSAGES_WHEN_WINDOW_UNSET = 30

/** 键：`providerId::model`（与 textProtocolKey 同形，用户在两处看到的是同一个键） */
export function modelWindowKey(providerId: string, model: string): string {
  return `${providerId}::${model}`
}

/**
 * 常见线上模型的内置上下文窗口（v78 第 3 批）。
 *
 * 为什么需要它：窗口此前只认用户手填，线上模型不填就回落到"最近 30 条"，
 * 128k 的 deepseek/qwen 被当成小模型对待。**用户显式配置永远优先**，这里只是默认值。
 * 取值刻意保守（宁可少带一点历史，也不要撞服务端 400）。
 */
const BUILTIN_MODEL_WINDOWS: ReadonlyArray<readonly [RegExp, number]> = [
  [/gpt-4\.1|gpt-4o|gpt-4-turbo|o1|o3|o4-mini|o3-mini/, 128_000],
  [/gpt-3\.5/, 16_385],
  [/deepseek/, 128_000],
  [/qwen3|qwen-plus|qwen-max|qwen-turbo|qwen-long|qwen2\.5|qwen2/, 131_072],
  [/qwq|qwen/, 32_768],
  [/claude/, 200_000],
  [/gemini/, 1_000_000],
  [/kimi|moonshot/, 131_072],
  [/glm-4/, 128_000],
  [/llama-?3/, 128_000],
  [/doubao/, 32_768],
  [/mistral-large|mistral-small/, 32_768]
]

/** 按模型名推断内置窗口；不认识返回 null（调用方回落到"最近 N 条"口径） */
export function builtinModelWindowTokens(model: string): number | null {
  const m = String(model ?? '').toLowerCase()
  if (!m) return null
  for (const [re, tokens] of BUILTIN_MODEL_WINDOWS) {
    if (re.test(m)) return tokens
  }
  return null
}

/** 主推理步的默认输出预算（本地/未知模型沿用旧口径） */
export const DEFAULT_AGENT_OUTPUT_TOKENS = 4096

/** 思考型模型：思考 token 也计入输出预算，给宽一档才不会把正文挤掉 */
const REASONING_MODEL_RE = /reasoner|reasoning|deepseek-r1|qwq|o1|o3|o4|thinking/

/**
 * 主推理步输出预算：思考模型 16k、其它已知云端模型 8k、未知/本地沿用 4k。
 * 上限还要被窗口兜住（给提示词和历史留至少 4k），避免"输出预留就把窗口吃光"。
 *
 * `remote=false`（本地端点）时不按模型名放宽：本地 `deepseek-r1:7b`/`qwen2.5:7b`
 * 名字同样命中这些模式，但本地服务端没有那个容量，给大预算只会白等或报错。
 */
export function resolveAgentOutputTokens(
  model: string,
  windowTokens: number | null,
  remote = true
): number {
  const m = String(model ?? '').toLowerCase()
  let out = DEFAULT_AGENT_OUTPUT_TOKENS
  if (remote) {
    if (REASONING_MODEL_RE.test(m)) out = 16_384
    else if (builtinModelWindowTokens(model) !== null) out = 8_192
  }
  if (windowTokens) out = Math.min(out, Math.max(1024, windowTokens - 4096))
  return out
}

/** 一个可作为窗口的整数？（NaN／小数／越界都算否） */
export function isModelWindowTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MODEL_WINDOW_MIN_TOKENS &&
    value <= MODEL_WINDOW_MAX_TOKENS
  )
}
