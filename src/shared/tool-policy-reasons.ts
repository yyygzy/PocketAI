// 工具策略屏的原因码（唯一真源）
//
// 主进程 shell-tools 的 deny/confirm 规则表、内置工具的 `policyReason`、渲染端的文案映射
// 都从这里的联合类型出发：规则表写了一个表外码，typecheck 直接红；渲染端漏一条文案，
// `satisfies Record<ToolPolicyReasonCode, string>` 也会红。
//
// 与 i18n 的 `tp.reason.*` 一一对应（四语同键，由 i18n-parity 守）。
export const TOOL_POLICY_REASON_CODES = [
  'BLOCKED_FORMAT',
  'BLOCKED_DISKPART',
  'BLOCKED_MKFS',
  'BLOCKED_SHUTDOWN',
  'BLOCKED_BOOTCFG',
  'BLOCKED_CIPHER_WIPE',
  'BLOCKED_REG_HIVE',
  'BLOCKED_SYSTEM_DELETE',
  'BLOCKED_FORKBOMB',
  'BLOCKED_ROOT_DELETE',
  'DANGEROUS_DELETE',
  'DANGEROUS_OVERWRITE',
  'DANGEROUS_WRITE',
  'DANGEROUS_KILL',
  'DANGEROUS_PERMISSION',
  'DANGEROUS_ACCOUNT',
  'DANGEROUS_REGISTRY',
  'DANGEROUS_PUBLISH',
  'DANGEROUS_PIPE_EXEC',
  'DANGEROUS_ENCODED',
  'DANGEROUS_INTERPRETER_INLINE',
  'DANGEROUS_EXEC_HOST',
  'DANGEROUS_PERSISTENCE',
  'DANGEROUS_DOWNLOAD_WRITE',
  'DANGEROUS_PRIVILEGE',
  'DANGEROUS_TRAVERSAL',
  'DANGEROUS_OUTSIDE',
  'REQUIRES_CONFIRM',
  'WRITES_WORKSPACE_FILE'
] as const

export type ToolPolicyReasonCode = (typeof TOOL_POLICY_REASON_CODES)[number]
