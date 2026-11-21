// MCP 子进程 env 合并策略（M8）
//
// 旧写法 `{ ...process.env, ...record.env }` 让用户配置覆盖了 PATH / NODE_OPTIONS /
// LD_PRELOAD 等：导入一份配置就等于改了子进程的动态链接器与命令查找路径。
// 新口径（失败关闭 + 安全值后置）：
//   1. 用户配置先写，危险键直接丢弃；
//   2. 应用侧 process.env 覆盖（应用自身环境是可信基准）；
//   3. safetyOverrides 最后写入（venv PATH / Python UTF-8 等应用侧安全值）。
// 这样 needsCmdShim 与实际 spawn 用的是同一份 PATH 判断结果。
import { isDangerousMcpEnvKey } from '../../shared/mcp-env-policy'

/** 丢弃用户配置里的危险键，保留普通业务变量 */
export function sanitizeMcpEnv(
  userEnv: Record<string, string> | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(userEnv ?? {})) {
    if (isDangerousMcpEnvKey(k)) continue
    out[k] = v
  }
  return out
}

/** 大小写不敏感取值（Windows 上 PATH / Path 混用） */
export function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const target = key.toLowerCase()
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === target) return v
  }
  return undefined
}

/**
 * 合并 env：用户配置 → 应用环境 → 安全覆盖（后者优先）。
 * safetyOverrides 由应用侧构造，不做危险键过滤（venv 需要写 PATH）。
 */
export function mergeMcpEnv(
  userEnv: Record<string, string> | null | undefined,
  safetyOverrides: Record<string, string> = {},
  baseEnv: Record<string, string | undefined> = process.env
): Record<string, string> {
  const out: Record<string, string> = { ...sanitizeMcpEnv(userEnv) }
  for (const [k, v] of Object.entries(baseEnv)) {
    if (v !== undefined) out[k] = v
  }
  for (const [k, v] of Object.entries(safetyOverrides)) {
    if (v !== undefined) out[k] = v
  }
  return out
}
