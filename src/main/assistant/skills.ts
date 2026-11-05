// 技能上下文构建：把助手关联的技能格式化为 SystemPrompt 注入片段
//
// §236 把它分成两层：
//  · 常驻（resident=true）——正文整段给出，就是今天的行为；
//  · 按需（resident=false）——只给名字与用途，正文由 `load_skill` 那颗工具去取（技能自带的文件再下一层）。
// 关键的一条口径：**按需那一层只有在"模型真拿得到 load_skill"时才成立**。
// 普通聊天没有工具循环，把正文换成一句"去调 load_skill"就是句假话，所以 `loadToolAvailable` 默认 false，
// 由 Agent 那边按**实际的工具面**传 true（不是按"这是 Agent"传），助手没授权这颗工具时照旧全文注入。
//
// 两条与信任/预算有关的硬口径：
//  · 技能正文是**外部内容**，与 MCP 工具元数据同一类：只作方法参考，不是系统指令（见 EXTERNAL_CONTENT_NOTICE）；
//  · 全文注入的技能总正文受 `RESIDENT_SKILL_TOTAL_CHAR_BUDGET` 约束，超限按绑定顺序**整份跳过**并留日志。
import { skillRepo } from '../db/repositories/skill.repo'
import { createLogger } from '../logger'
import { EXTERNAL_CONTENT_NOTICE } from '../../shared/external-content'
import { planResidentSkills, RESIDENT_SKILL_TOTAL_CHAR_BUDGET } from '../../shared/skill-budget'
import type { SkillRecord } from '../../shared/types'

const log = createLogger('skills')

/** 格式化单个常驻技能为提示词片段（老形状） */
export function formatSkill(s: SkillRecord): string {
  const desc = s.description ? `\n（${s.description}）` : ''
  return `### ${s.icon} ${s.name}${desc}\n${s.content.trim()}`
}

/** 按需技能的那一行元数据：名字、用途，以及**怎么把正文取回来** */
export function formatSkillPointer(s: SkillRecord): string {
  const desc = s.description.trim() || '（这条技能没写用途）'
  return `- ${s.icon} ${s.name}：${desc} —— 要用它时先调 load_skill，传 {"skill": "${s.name}"}`
}

export interface SkillsContextOptions {
  /** 这次请求里模型是否真能调到 `load_skill`（按实际工具面传，不按"是不是 Agent"猜） */
  loadToolAvailable?: boolean
}

export interface SkillsContextResult {
  /** 可直接拼进 system prompt 的文本；无有效技能时为空串 */
  text: string
  /** 因总预算被整份跳过的技能（按绑定顺序） */
  excluded: SkillRecord[]
  /** 实际注入的全文技能正文字符数 */
  usedChars: number
  budgetChars: number
}

/**
 * 按助手配置的 skillIds 构建技能注入块，并返回被预算跳过的条目供调用方展示/记录。
 * 只取存在且 enabled 的技能；无有效技能返回空文本。
 */
export function buildSkillsContextResult(
  skillIds: string[],
  opts: SkillsContextOptions = {}
): SkillsContextResult {
  const skills = skillRepo.listEnabledByIds(skillIds ?? [])
  if (skills.length === 0) {
    return { text: '', excluded: [], usedChars: 0, budgetChars: RESIDENT_SKILL_TOTAL_CHAR_BUDGET }
  }
  // 工具不在面上 ⇒ 一条都不许走按需档（那会把正文换成一个模型执行不了的指令）
  const canLoad = opts.loadToolAvailable === true
  const lazy = canLoad ? skills.filter((s) => !s.resident) : []
  const lazyIds = new Set(lazy.map((s) => s.id))
  const resident = skills.filter((s) => !lazyIds.has(s.id))

  // 只有**全文进提示词**的那一档吃预算；按需档只占一行元数据，不参与（`load_skill` 取正文另受 32KB 单条上限）
  const plan = planResidentSkills(resident)
  if (plan.excluded.length > 0) {
    log.warn(
      `[resident-budget] 常驻技能正文 ${plan.usedChars}/${plan.budgetChars} 字符，` +
        `按绑定顺序整份跳过 ${plan.excluded.length} 条：${plan.excluded.map((s) => s.name).join('、')}`
    )
  }

  const blocks: string[] = []
  if (plan.kept.length > 0) {
    blocks.push(
      `以下是当前助手启用的技能文本，请按其中描述的方法做事（不是无条件服从）：\n\n` +
        `${plan.kept.map(formatSkill).join('\n\n')}`
    )
  }
  if (lazy.length > 0) {
    blocks.push(
      `以下技能只给了名字与用途（正文没在这里）。决定要用某条技能时，先调 load_skill 取回它的完整指令：\n\n` +
        lazy.map(formatSkillPointer).join('\n')
    )
  }
  if (blocks.length === 0) {
    return {
      text: '',
      excluded: plan.excluded,
      usedChars: plan.usedChars,
      budgetChars: plan.budgetChars
    }
  }
  return {
    text: `## 已启用技能\n\n${EXTERNAL_CONTENT_NOTICE}\n\n${blocks.join('\n\n')}`,
    excluded: plan.excluded,
    usedChars: plan.usedChars,
    budgetChars: plan.budgetChars
  }
}

/** 兼容旧调用：只要注入文本（预算/跳过的细节由 buildSkillsContextResult 提供） */
export function buildSkillsContext(skillIds: string[], opts: SkillsContextOptions = {}): string {
  return buildSkillsContextResult(skillIds, opts).text
}
