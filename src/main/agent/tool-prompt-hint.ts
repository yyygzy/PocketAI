// 本轮可用工具提示（v78 第 4 批）
//
// 解决的问题：默认系统提示词里那份「工具使用场景」是静态写死的（点名 weather_query、
// fs_read、web_search…），但真正发出去的 tools 可能因为分组裁剪、未配置工作目录、
// MCP 未逐条授权而不在里面。模型于是照着提示词去调一个**不存在**的工具，最终以
// "工具不存在"收场。这里按**本轮实际下发的工具集**生成一份权威清单，并明确
// 「未列出 = 本轮不可用」——提示词与请求面从此同一份事实。
import type { ToolSchema } from '../../shared/types'

/** 单条描述截断长度：只要"它是干什么的"，不要整段 schema 说明 */
const BRIEF_MAX_CHARS = 80

function brief(description: string | undefined): string {
  const d = String(description ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!d) return '（无描述）'
  const firstClause = d.split(/[。；;]/)[0] ?? d
  return firstClause.length > BRIEF_MAX_CHARS
    ? `${firstClause.slice(0, BRIEF_MAX_CHARS - 1)}…`
    : firstClause
}

/**
 * 生成「本轮可用工具」段；没有工具时返回空串（调用方据此不追加）。
 * 文本协议模式下不生成：那份清单已由 buildTextProtocolPrompt 带 schema 完整注入。
 */
export function buildAvailableToolsHint(tools: ToolSchema[]): string {
  if (!Array.isArray(tools) || tools.length === 0) return ''
  const lines = tools.map((t) => `- ${t.name}：${brief(t.description)}`)
  return [
    '## 本轮可用工具（以此为准）',
    '只允许调用下列工具；未列出的工具本轮不可用，不要调用，也不要声称已经调用过。',
    lines.join('\n')
  ].join('\n')
}
