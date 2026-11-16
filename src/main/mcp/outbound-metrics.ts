// MCP 出口计数（零依赖，可被 transport 单独引用）
//
// 单独成一个模块的原因：`http-transport.ts` 是协议实现，单元测试不该为了它去拉
// `app_config` → 数据库 → electron 那一整条链。策略判定需要读配置，计数不需要。
//
// 口径：
//  - HTTP 请求数：HTTP 传输每次真正 POST 前加一（含 initialize / tools/list / tools/call）。
//  - `tools/call` 数：两种传输共用（stdio 的用户唯一可观测出口），口径是**尝试次数**。
// 这两个数只被 dry-run 回放前后取差做全等断言，不改变任何出网行为。

let httpRequestCount = 0
let toolCallCount = 0

/** HTTP 传输即将发出一次请求（调用点紧贴 fetch，被站点策略拒掉的不计） */
export function noteMcpHttpRequest(): void {
  httpRequestCount++
}

/** 即将发出一次 `tools/call`；网络失败或未通过站点策略也计入——"想让它干活"本身就要留痕 */
export function noteMcpToolCall(): void {
  toolCallCount++
}

export function getMcpHttpRequestCount(): number {
  return httpRequestCount
}

export function getMcpToolCallCount(): number {
  return toolCallCount
}
