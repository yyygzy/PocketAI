// 工具面兜底判定（v79 第二批）
//
// 收窄是常态，但收窄有代价：命中词没覆盖到，模型面前就是一套不完整的工具箱。
// 两种可观测的失败信号各给一次全量重试的机会：
//  1. 收窄后工具集为空（分组把仅有的几枚都裁掉了）；
//  2. 模型在回复里明确声称"没有可用工具"。
// 只给一次：`alreadyUsed` 由调用方（引擎）持有，任何时候都不能循环重试。
//
// 这里的判定必须是纯函数：同一个文本/计数恒得同一结果（用例钉着，引擎只负责执行）。

/** 「声称没有可用工具」的严格措辞：宁可漏判，也不要把正常回答误判成故障重跑 */
const NO_TOOLS_CLAIM_PATTERNS: readonly RegExp[] = [
  /没有(?:任何)?(?:可用的)?工具(?:可用)?/i,
  /无(?:任何)?可用工具/i,
  /无法(?:使用|调用)(?:任何)?工具/i,
  /不能(?:使用|调用)(?:任何)?工具/i,
  /工具(?:不可用|无法使用|不可调用)/i,
  /(?:no|zero) (?:available )?tools/i,
  /tools (?:are|is) not available/i,
  /(?:don't|do not) have (?:access to )?(?:any )?tools/i,
  /cannot (?:use|access|call) (?:any )?tools/i
]

/** 模型是否明确声称「没有可用工具」 */
export function claimsNoTools(text: string): boolean {
  const t = String(text ?? '')
  if (!t.trim()) return false
  return NO_TOOLS_CLAIM_PATTERNS.some((re) => re.test(t))
}

/** 收窄后工具集为空时，是否该直接换全量（仍需调用方确认授权面非空，绝不越过授权） */
export function shouldFallbackOnEmptySurface(input: {
  fallbackEnabled: boolean
  narrowedCount: number
  /** 授权面（裁剪前）的工具数；为 0 说明是授权问题，不是分组问题 */
  authorizedCount: number
  alreadyUsed: boolean
}): boolean {
  return (
    input.fallbackEnabled &&
    !input.alreadyUsed &&
    input.narrowedCount === 0 &&
    input.authorizedCount > 0
  )
}

/**
 * 模型回复声称无工具时，是否该换全量重试一次。
 * 条件缺一不可：允许兜底、还没用过、全量确实比当前面多、本轮没有工具调用、且文本确为声称。
 */
export function shouldFallbackOnClaim(input: {
  fallbackEnabled: boolean
  alreadyUsed: boolean
  toolCallsCount: number
  narrowedCount: number
  fullCount: number
  text: string
}): boolean {
  return (
    input.fallbackEnabled &&
    !input.alreadyUsed &&
    input.toolCallsCount === 0 &&
    input.fullCount > input.narrowedCount &&
    claimsNoTools(input.text)
  )
}
