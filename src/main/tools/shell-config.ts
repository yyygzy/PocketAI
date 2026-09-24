// shell_exec 工具的全局策略配置（app_config KV）
//
// - agent.shell_enabled：'1' 开启；缺省/其它=关闭（默认安全）
// - agent.shell_policy ：'confirm'（默认，逐条确认）| 'auto-safe'（仅危险确认）
//
// 注意：这是「受限终端」而非沙箱——即使开启，命令仍以应用自身权限运行，
// 安全依赖工作目录锚定 + 命令分类 + 用户审批。
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { ShellConfig, ShellPolicy } from '../../shared/types'
import { shellConfigSchema } from '../../shared/schemas/agent'

const KEY_ENABLED = 'agent.shell_enabled'
const KEY_POLICY = 'agent.shell_policy'

/** 读取终端策略；非法/缺省值回退到安全默认 */
export function getShellConfig(): ShellConfig {
  const enabled = appConfigRepo.get(KEY_ENABLED) === '1'
  const policyRaw = appConfigRepo.get(KEY_POLICY)
  const policy: ShellPolicy = policyRaw === 'auto-safe' ? 'auto-safe' : 'confirm'
  return { enabled, policy }
}

/** 保存终端策略（字段白名单 + 值域校验） */
export function setShellConfig(input: Partial<ShellConfig>): ShellConfig {
  const patch = shellConfigSchema.parse(input)
  if (typeof patch.enabled === 'boolean') {
    appConfigRepo.set(KEY_ENABLED, patch.enabled ? '1' : '0')
  }
  if (patch.policy === 'confirm' || patch.policy === 'auto-safe') {
    appConfigRepo.set(KEY_POLICY, patch.policy)
  }
  return getShellConfig()
}
