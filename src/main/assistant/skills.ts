// 技能上下文构建：把助手关联的技能格式化为 SystemPrompt 注入片段
//
// §236 把它分成两层：
//  · 常驻（resident=true）——正文整段给出，就是今天的行为，一条都不变；
//  · 按需（resident=false）——只给名字与用途，正文由 `load_skill` 那颗工具去取（技能自带的文件再下一层）。
// 关键的一条口径：**按需那一层只有在"模型真拿得到 load_skill"时才成立**。
// 普通聊天没有工具循环，把正文换成一句"去调 load_skill"就是句假话，所以 `loadToolAvailable` 默认 false，
// 由 Agent 那边按**实际的工具面**传 true（不是按"这是 Agent"传），助手没授权这颗工具时照旧全文注入。
import { skillRepo } from '../db/repositories/skill.repo'
import type { SkillRecord } from '../../shared/types'

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

/**
 * 按助手配置的 skillIds 构建技能注入块。
 * 只取存在且 enabled 的技能；无有效技能返回空字符串。
 */
export function buildSkillsContext(skillIds: string[], opts: SkillsContextOptions = {}): string {
  const skills = skillRepo.listEnabledByIds(skillIds ?? [])
  if (skills.length === 0) return ''
  // 工具不在面上 ⇒ 一条都不许走按需档（那会把正文换成一个模型执行不了的指令）
  const canLoad = opts.loadToolAvailable === true
  const lazy = canLoad ? skills.filter((s) => !s.resident) : []
  const lazyIds = new Set(lazy.map((s) => s.id))
  const resident = skills.filter((s) => !lazyIds.has(s.id))

  const blocks: string[] = []
  if (resident.length > 0) {
    blocks.push(
      `以下是当前助手启用的技能指令，请在回答中严格遵循：\n\n${resident.map(formatSkill).join('\n\n')}`
    )
  }
  if (lazy.length > 0) {
    blocks.push(
      `以下技能只给了名字与用途（正文没在这里）。决定要用某条技能时，先调 load_skill 取回它的完整指令：\n\n` +
        lazy.map(formatSkillPointer).join('\n')
    )
  }
  return `## 已启用技能\n\n${blocks.join('\n\n')}`
}
