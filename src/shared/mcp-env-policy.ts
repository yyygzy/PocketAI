// MCP 子进程 env 的危险键（M8）：配置导入/保存时拒绝，运行时合并时再兜底丢弃一次。
// 只列会改变动态链接器/解释器/命令查找行为的键；普通业务变量（API_KEY 等）不受限制。

/** 精确匹配的危险键（比较时忽略大小写） */
export const MCP_DANGEROUS_ENV_KEYS = [
  'ld_preload',
  'ld_library_path',
  'ld_audit',
  'node_options',
  'pythonpath',
  'pythonhome',
  'comspec',
  'pathext',
  // 禁止用户配置覆盖 PATH：needsCmdShim 与实际 spawn 必须看同一份 PATH
  'path'
] as const

/** 前缀匹配的危险键：DYLD_*（macOS 动态注入） */
export const MCP_DANGEROUS_ENV_PREFIXES = ['dyld_'] as const

export function isDangerousMcpEnvKey(key: string): boolean {
  const k = key.toLowerCase()
  return (
    (MCP_DANGEROUS_ENV_KEYS as readonly string[]).includes(k) ||
    MCP_DANGEROUS_ENV_PREFIXES.some((p) => k.startsWith(p))
  )
}
