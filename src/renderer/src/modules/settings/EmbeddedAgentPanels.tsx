// P3 / V4-Iter-460：MCP 与 Channels 在设置页的挂载（只做加法：Agent 壳旧标签保留到 P4）
// 设置页与 Agent 壳挂的是同一份面板组件，不各留一份；面板本身不改逻辑，只改挂载位置。
import React from 'react'
import { McpPanel } from '../agent/mcp/McpPanel'
import { ChannelsPanel } from '../agent/channels/ChannelsPanel'

// 设置页是一条长滚动流：这两个面板自带 `h-full` 与内部滚动区，给它们一个确定高度，
// 否则 `h-full` 会跟整页高度互相拉扯（内层滚动区失去边界）。
const PANEL_HEIGHT = 'min(70vh, 640px)'

export const CapabilitySettingsPanel: React.FC = () => (
  <div data-testid="settings-mcp-panel" style={{ height: PANEL_HEIGHT }}>
    <McpPanel />
  </div>
)

export const ConnectionSettingsPanel: React.FC = () => (
  <div data-testid="settings-channels-panel" style={{ height: PANEL_HEIGHT }}>
    <ChannelsPanel />
  </div>
)
