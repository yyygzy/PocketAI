// 编辑后自动验证开关（默认关）。
//
// 这是"愿意多花几十秒换一个闭环"的用户选择，不是安全属性：
// 缺省/读取异常一律关，绝不在用户没同意时突然跑 typecheck / vitest。
import { appConfigRepo } from '../db/repositories/app-config.repo'

const K_POST_EDIT_VALIDATION = 'agent.post_edit_validation_enabled'

export function isPostEditValidationEnabled(): boolean {
  try {
    return appConfigRepo.get(K_POST_EDIT_VALIDATION) === '1'
  } catch {
    return false
  }
}

export function setPostEditValidationEnabled(on: boolean): boolean {
  try {
    appConfigRepo.set(K_POST_EDIT_VALIDATION, on ? '1' : '0')
    return true
  } catch {
    return false
  }
}

export interface PostEditValidationPrefs {
  enabled: boolean
}

export function getPostEditValidationPrefs(): PostEditValidationPrefs {
  return { enabled: isPostEditValidationEnabled() }
}
