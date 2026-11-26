// 从 app_config 读技能路由的灰度开关；读取失败一律退回关闭，不让实验开关带崩正常对话。
// 单独成层是为了让 buildSkillsContext 保持纯函数测试友好（不必在单测里打开 config.json）。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import { DEFAULT_SKILL_ROUTING_TOP_N, type SkillRoutingOptions } from '../../shared/skill-routing'

export function configuredSkillRouting(taskDescription: string): SkillRoutingOptions {
  try {
    const enabled = appConfigRepo.isSkillRoutingEnabled?.() === true
    return {
      enabled,
      taskDescription,
      topN: appConfigRepo.getSkillRoutingTopN?.() ?? DEFAULT_SKILL_ROUTING_TOP_N
    }
  } catch {
    return { enabled: false, taskDescription }
  }
}
