// 虚拟消息列表滚底逻辑纯函数：抽离以便单元测试
// 项目约定：渲染层不依赖 node API（contextIsolation:true + nodeIntegration:false）

/**
 * 判断当前滚动位置是否处于「底部锚定区」。
 *
 * 当内容不超出容器（scrollHeight <= clientHeight）时视为已在底部，
 * 避免空列表/短列表被误判为「用户向上滚过」。
 */
export function isNearBottom(
  scrollTop: number,
  scrollHeight: number,
  clientHeight: number,
  threshold = 48
): boolean {
  if (scrollHeight <= clientHeight) return true
  return scrollHeight - scrollTop - clientHeight <= threshold
}

/**
 * 流式追加消息时判断是否应自动滚到底部。
 *
 * 决策规则（用历史锚定状态而非瞬时 scroll 位置，避免 scroll 事件与新消息
 * effect 的竞态导致抖动）：
 * - 非流式（running=false）→ 不主动滚（交由切会话 effect 处理）
 * - 流式中且之前在底部锚定区（wasAtBottom=true）→ 跟滚
 * - 流式中但用户已主动离开底部（wasAtBottom=false）→ 不跟滚，尊重用户阅读
 */
export function shouldStickToBottom(
  _currentlyNearBottom: boolean,
  wasAtBottom: boolean,
  running: boolean
): boolean {
  if (!running) return false
  return wasAtBottom
}
