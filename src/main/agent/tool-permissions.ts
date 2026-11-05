// 工具授权解析（纯函数，SEC-3）
//
// 单独成文件是为了让「策略屏」与「Agent 运行」共用同一份语义：
// 注册表不能 import engine（engine 依赖 registry，会成环），所以把这条不依赖任何运行时状态的
// 规则放在这里，engine 与 IPC 两侧都从这里取。
//
// 规则：
// - 助手显式配置了 toolPermissions → 原样生效（`['*']` 是显式的全授权声明，
//   但**只覆盖内置工具**，MCP 工具仍需逐条 id —— 见 `tools/registry.ts` 的 `isToolAllowedBy`）；
// - 空数组 = **不授权任何工具**；只有两种情形保留旧的「空即全授权」：
//   未选助手（平台默认 Agent 会话）与内置助手（避免升级后历史助手突然失去全部能力）。
// 曾经的无条件 `[] → ['*']` 让「拿到一个助手 JSON」等价于「拿到全授权 Agent（含 shell_exec）」。
export function resolveAgentToolPermissions(
  assistantPermissions: string[] | null | undefined,
  opts: { hasAssistant: boolean; isBuiltin: boolean }
): string[] {
  const list = Array.isArray(assistantPermissions) ? assistantPermissions : []
  if (list.length > 0) return list
  return opts.hasAssistant && !opts.isBuiltin ? [] : ['*']
}
