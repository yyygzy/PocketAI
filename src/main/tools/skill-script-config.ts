// 技能脚本执行的灰度开关：读取失败一律退回关闭；工具层不直接依赖 DB 可用性。
import { appConfigRepo } from '../db/repositories/app-config.repo'

export function isSkillScriptExecutionEnabled(): boolean {
  try {
    return appConfigRepo.isSkillScriptEnabled?.() === true
  } catch {
    return false
  }
}
