// Jev 语义审核增强：把一次 /v1/systemone 的 score 判定折算成"要不要升级为人工确认"。
//
// 铁律（与 §250/§380 那批同口径）：
//  - 决策失败、服务没跑、模型没拉、返回不合形状 ⇒ 一律 fail-open，返回 'passthrough'，
//    绝不让"我们不知道"变成"拦下来"或"放过去"的确定结论；
//  - 只在调用方显式开启时才跑；开关关时连请求都不发；
//  - 这是补充信号，最终判定仍由规则式 classify 与用户审批决定。
import { runSystemOne } from '../ollama/systemone'
import { getJevModel, getJevThreshold, isJevReviewEnabled } from './jev-review-prefs'
import { createLogger } from '../logger'

const log = createLogger('jev-review')

/** 风险评分固定三档：Safe / Moderate / Dangerous（score 是概率×档位索引的加权分） */
const RISK_CRITERIA = ['Safe', 'Moderate', 'Dangerous'] as const

export type JevReviewDecision = 'passthrough' | 'confirm'

export interface JevReviewInput {
  /** 工具名（进 state，让决策模型知道要看什么动作） */
  toolName: string
  /** 已脱敏的参数摘要（不把原始密钥/大文本送进决策模型） */
  argsSummary: string
}

export interface JevReviewResult {
  decision: JevReviewDecision
  /** 风险分（仅决策成功时有值），供审计/展示 */
  score?: number
  /** 没跑/失败的原因，fail-open 时写日志用 */
  reason?: string
}

/** 任何异常都收成 passthrough：审核增强永远不许把一次模型调用失败变成用户可见的拦截 */
function passthrough(reason: string): JevReviewResult {
  return { decision: 'passthrough', reason }
}

export async function reviewToolCall(input: JevReviewInput): Promise<JevReviewResult> {
  if (!isJevReviewEnabled()) return passthrough('disabled')

  const toolName = String(input.toolName ?? '').slice(0, 200)
  const argsSummary = String(input.argsSummary ?? '').slice(0, 2000)
  if (!toolName) return passthrough('empty_tool_name')

  try {
    const res = await runSystemOne({
      model: getJevModel(),
      state: { tool: toolName, args: argsSummary },
      questions: {
        risk: {
          type: 'score',
          instructions: 'How risky is this tool call? Consider destructive file changes, network sends, and privilege escalation.',
          criteria: [...RISK_CRITERIA]
        }
      }
    })
    const answer = res.answers?.risk
    if (!answer || answer.type !== 'score' || typeof answer.score !== 'number' || !Number.isFinite(answer.score)) {
      return passthrough('bad_answer')
    }
    // score 是「概率×档位索引」的加权分，不是 0-1：三档时理论范围约 0-2
    // （实测 tev1:0.8b 对三档返回 1.07）。这里请求固定三档，按 (档位数-1)=2 归一化到 0-1，
    // 否则任何非空回答都会被当成高风险，审核增强就退化成"全部拦"。
    const normalized = answer.score / (RISK_CRITERIA.length - 1)
    return normalized >= getJevThreshold()
      ? { decision: 'confirm', score: normalized }
      : { decision: 'passthrough', score: normalized }
  } catch (e) {
    log.warn(`Jev 审核决策失败，保持原判定：${e instanceof Error ? e.message : String(e)}`)
    return passthrough('error')
  }
}

export const jevReview = { reviewToolCall }
