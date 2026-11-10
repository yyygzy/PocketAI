// 技能静态扫描的结果形状（主进程产出、渲染层展示共用）
//
// 这里只放类型，扫描规则与判定在主进程 `src/main/skills/skill-scan.ts`。
// 语义边界：findings 是「候选与事实」，不是安全判定，也不代表运行时行为。
export type SkillFindingLevel = 'info' | 'notice' | 'attention'
export type SkillScanLevel = 'none' | SkillFindingLevel
export type SkillFindingWhere = 'content' | 'resource' | 'declaration'

/** 随包资源清单的一项（只读路径与大小，不读内容） */
export interface SkillScanResource {
  path: string
  size?: number
}

export interface SkillScanInput {
  content: string
  resources?: SkillScanResource[]
  /** 解析器给出的白名单外声明字段（本应用不执行） */
  ignoredKeys?: string[]
}

export interface SkillFinding {
  /** 稳定码，供审计与界面映射，不随文案变化 */
  code: string
  level: SkillFindingLevel
  where: SkillFindingWhere
  /** 事实描述：说「出现了什么」，不说「危不危险」 */
  detail: string
  count: number
  /** 去重后的命中片段/路径，最多 5 条 */
  examples: string[]
}

export interface SkillScanResult {
  level: SkillScanLevel
  findings: SkillFinding[]
  counts: Record<SkillFindingLevel, number>
  scannedChars: number
  resourceCount: number
}
