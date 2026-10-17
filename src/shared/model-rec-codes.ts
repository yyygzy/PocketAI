// 平台管家·模型推荐这一屏的**码表**（V4-Iter-156）
//
// 为什么要把句子从主进程搬走：这张表是**按硬件分支**生成的静态数据（11 个分支 × 档位/总结/推荐语/告警），
// 以前中文整句直接进 `steward:model-recommend` 的返回值 ⇒ en / ja / ko 界面上读到的是中文原句
// （实测 60 串/语言：8 档位名 + 11 句硬件总结 + 3 个标签值 + 32 条推荐语 + 4 条告警 + 2 条在线建议，
// 其中档位与总结还直接显示在**首启向导**那一屏，`FirstRunWizard.tsx:363,417`）。
// 口径与 152 一致：**主进程给码 + 参数，句子只住四语字典**；先例是 `ToolApprovalDialog.tsx:87` 与
// `LocalJudgementPanel.tsx:84`（都是 `t(前缀 + code)`）。
//
// 两个字段以前还兼做**逻辑判断**，所以码化不只是翻译：
//  · `OllamaPanel.tsx:132,133` 用 `p.tag === '向量'` 挑向量模型 ⇒ 现在是 `tag === 'embedding'`；
//  · `model-recommend.ts:212` 用 `/入门|低配/.test(tier)` 判低配 ⇒ 现在是 `isLowEndTier(tier)`。
// 两处都靠"中文字面匹配"：换界面语言不会坏，但**换措辞就静默坏** ⇒ 码化后由类型系统守着。
//
// 为什么码写在字面量联合里而不是 `string`：加一档硬件 / 加一条推荐而忘了登记，
// 编译期就红（`string` 的话要等到界面上出现裸码或用例跑挂才知道）。

export type ModelTierCode =
  | 'flagship'
  | 'high'
  | 'mainstream'
  | 'entry'
  | 'high_cpu'
  | 'mainstream_cpu'
  | 'entry_cpu'
  | 'low'

/** 硬件总结的码 = 分支名（nvidia 四档 / Apple Silicon 三档 / 纯 CPU 四档） */
export type ModelSummaryCode =
  | 'nv_flagship'
  | 'nv_high'
  | 'nv_mainstream'
  | 'nv_entry'
  | 'mps_flagship'
  | 'mps_high'
  | 'mps_mainstream'
  | 'cpu_high'
  | 'cpu_mainstream'
  | 'cpu_entry'
  | 'cpu_low'

export type ModelPickTagCode = 'primary' | 'alternate' | 'embedding'

/** 每条推荐的说明（同一个码可以在多个分支复用：文案相同才复用，不同就另开码） */
export type ModelReasonCode =
  | 'qwen32b_24g'
  | 'deepseek_r1_14b_reasoning'
  | 'qwen14b_q5_daily'
  | 'qwen14b_q5_longctx'
  | 'deepseek_r1_7b_thinking'
  | 'qwen7b_speed_daily'
  | 'qwen7b_q4_6g'
  | 'llama31_8b_english'
  | 'deepseek_r1_15b_fast'
  | 'qwen3b_q4_lowvram'
  | 'llama32_3b_general'
  | 'qwen15b_emergency'
  | 'qwen32b_mps'
  | 'qwen14b_daily_mps'
  | 'deepseek_r1_14b_alt'
  | 'qwen14b_q4_mps'
  | 'qwen7b_speed_alt'
  | 'deepseek_r1_7b_light'
  | 'qwen7b_q4_mac8g'
  | 'qwen3b_q4_smooth'
  | 'llama32_3b_english_light'
  | 'qwen7b_q4_cpu_primary'
  | 'qwen14b_q4_cpu_patience'
  | 'qwen3b_q4_cpu_speed'
  | 'qwen7b_q4_cpu_pick'
  | 'qwen3b_cpu_faster'
  | 'qwen3b_q4_lowmem_primary'
  | 'qwen15b_background'
  | 'qwen15b_ultra_light'
  | 'llama32_1b_last_resort'
  | 'qwen3b_try_if_ram'
  | 'bge_m3_kb'

export type ModelWarnCode = 'mem_lt8' | 'no_gpu_accel' | 'disk_lt10g' | 'no_ollama'

/** 在线模型建议：低配档与非低配档各一句 */
export type ModelOnlineHintCode = 'low_end' | 'general'

export type ModelRecKind = 'tier' | 'summary' | 'tag' | 'reason' | 'warn' | 'onlineHint'

/** 码 → i18n 键前缀：界面与用例都从这一处拼键，别两处各写一遍 */
export const MODEL_REC_PREFIX: Record<ModelRecKind, string> = {
  tier: 'modelRec.tier.',
  summary: 'modelRec.summary.',
  tag: 'modelRec.tag.',
  reason: 'modelRec.reason.',
  warn: 'modelRec.warn.',
  onlineHint: 'modelRec.onlineHint.'
}

export function modelRecKey(kind: ModelRecKind, code: string): string {
  return MODEL_REC_PREFIX[kind] + code
}

/** 低配档 ⇒ 换另一句在线建议（原来是对中文档位名做正则） */
export function isLowEndTier(tier: ModelTierCode): boolean {
  return tier === 'entry' || tier === 'entry_cpu' || tier === 'low'
}

/**
 * 各码的全清单。**用例拿它反查四本字典**（`tests/model-recommend-codes.test.ts`）：
 * 加一档硬件 / 加一条推荐而漏译 ⇒ 当场红，而不是界面上出现裸码。
 * 清单与上面的类型联合是同一批人维护的两份 ⇒ 用例还断"清单里的每条码都能被 `pickByHardware` 实际产出"，
 * 免得清单漂成一份没人用的登记表。
 */
export const MODEL_REC_CODES: Record<ModelRecKind, readonly string[]> = {
  tier: [
    'flagship',
    'high',
    'mainstream',
    'entry',
    'high_cpu',
    'mainstream_cpu',
    'entry_cpu',
    'low'
  ] as ModelTierCode[],
  summary: [
    'nv_flagship',
    'nv_high',
    'nv_mainstream',
    'nv_entry',
    'mps_flagship',
    'mps_high',
    'mps_mainstream',
    'cpu_high',
    'cpu_mainstream',
    'cpu_entry',
    'cpu_low'
  ] as ModelSummaryCode[],
  tag: ['primary', 'alternate', 'embedding'] as ModelPickTagCode[],
  warn: ['mem_lt8', 'no_gpu_accel', 'disk_lt10g', 'no_ollama'] as ModelWarnCode[],
  onlineHint: ['low_end', 'general'] as ModelOnlineHintCode[],
  reason: [
    'qwen32b_24g',
    'deepseek_r1_14b_reasoning',
    'qwen14b_q5_daily',
    'qwen14b_q5_longctx',
    'deepseek_r1_7b_thinking',
    'qwen7b_speed_daily',
    'qwen7b_q4_6g',
    'llama31_8b_english',
    'deepseek_r1_15b_fast',
    'qwen3b_q4_lowvram',
    'llama32_3b_general',
    'qwen15b_emergency',
    'qwen32b_mps',
    'qwen14b_daily_mps',
    'deepseek_r1_14b_alt',
    'qwen14b_q4_mps',
    'qwen7b_speed_alt',
    'deepseek_r1_7b_light',
    'qwen7b_q4_mac8g',
    'qwen3b_q4_smooth',
    'llama32_3b_english_light',
    'qwen7b_q4_cpu_primary',
    'qwen14b_q4_cpu_patience',
    'qwen3b_q4_cpu_speed',
    'qwen7b_q4_cpu_pick',
    'qwen3b_cpu_faster',
    'qwen3b_q4_lowmem_primary',
    'qwen15b_background',
    'qwen15b_ultra_light',
    'llama32_1b_last_resort',
    'qwen3b_try_if_ram',
    'bge_m3_kb',
  ] as ModelReasonCode[]
}
