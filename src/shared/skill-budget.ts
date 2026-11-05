// 常驻技能正文的总预算（渲染层与主进程共用同一份规划函数）
//
// 单条上限由 skill-parser 管：常驻 8KB、按需 32KB。但那两道只管「一条」，管不住「十条」——
// 绑定十条常驻技能就会把大半个上下文窗口吃掉。这里再加一道**总量**闸。
//
// 截断口径：
//  · 顺序 = 调用方传入的顺序（绑定顺序），不读 DB 返回顺序，因此同一份绑定每次截法一致；
//  · 粒度 = **整份技能丢弃**，不保留开头若干字。半截技能比没有更糟：模型会以为看到了完整方法，
//    却缺了后半段的关键约束；整份跳过则能与「被跳过的条数/名字」一起如实报出来。
//  · 一旦某一条放不下，就以此为分界线，后续条目也整份跳过（前缀式截断），不做「跳过大的、塞进后面小的」
//    这种依赖内容长度的拼凑——否则预算一改，留下的组合就会变。
import type { SkillRecord } from './types'

/** 常驻技能正文总预算：32KB ≈ 4 条满额常驻技能（单条常驻上限 8KB） */
export const RESIDENT_SKILL_TOTAL_CHAR_BUDGET = 32 * 1024

export interface ResidentSkillPlan {
  /** 按传入顺序保留的技能 */
  kept: SkillRecord[]
  /** 因预算被整份跳过的技能（同样按传入顺序） */
  excluded: SkillRecord[]
  usedChars: number
  budgetChars: number
}

/** 按绑定顺序规划常驻技能：放得下就整份保留，放不下就整份跳过并以此为分界线 */
export function planResidentSkills(
  skills: SkillRecord[],
  budgetChars: number = RESIDENT_SKILL_TOTAL_CHAR_BUDGET
): ResidentSkillPlan {
  const kept: SkillRecord[] = []
  const excluded: SkillRecord[] = []
  let used = 0
  let cut = false
  for (const s of skills) {
    const cost = String(s.content ?? '').trim().length
    if (cut || used + cost > budgetChars) {
      cut = true
      excluded.push(s)
      continue
    }
    used += cost
    kept.push(s)
  }
  return { kept, excluded, usedChars: used, budgetChars }
}
