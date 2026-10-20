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

/** 一个可作为窗口的整数？（NaN／小数／越界都算否） */
export function isModelWindowTokens(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MODEL_WINDOW_MIN_TOKENS &&
    value <= MODEL_WINDOW_MAX_TOKENS
  )
}
