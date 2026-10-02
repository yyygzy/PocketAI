// 用量明细 CSV 构建（纯函数，表头由渲染端 i18n 注入；主进程只管弹框落盘）
// 文件头带 UTF-8 BOM，Excel 直接打开中文不乱码；字段按 RFC 4180 规则转义
import type { UsageDetailItem } from '../../../shared/types'

/** CSV 表头（顺序即列顺序，共 10 列） */
export interface UsageCsvHeader {
  time: string
  conversation: string
  assistant: string
  provider: string
  model: string
  prompt: string
  completion: string
  cached: string
  total: string
  cost: string
}

/** 单元格转义：含逗号/双引号/换行时双引号包裹，内部双引号翻倍 */
export function csvCell(value: string | number): string {
  const s = String(value)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** 本地时间格式化 YYYY-MM-DD HH:mm:ss（不依赖 locale，与诊断报告导出同手法） */
export function formatLocalTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * 构建用量明细 CSV：BOM + 表头 + 明细行（明细保持 service 返回的时间倒序）。
 * assistantName 为 null（自由会话/助手已删除）时该列输出空串。
 */
export function buildUsageCsv(items: UsageDetailItem[], h: UsageCsvHeader): string {
  const lines: string[] = []
  lines.push([h.time, h.conversation, h.assistant, h.provider, h.model, h.prompt, h.completion, h.cached, h.total, h.cost].map(csvCell).join(','))
  for (const it of items) {
    lines.push(
      [
        formatLocalTime(it.createdAt),
        it.conversationTitle,
        it.assistantName ?? '',
        it.provider,
        it.model,
        it.promptTokens,
        it.completionTokens,
        it.cachedTokens,
        it.totalTokens,
        it.cost
      ].map(csvCell).join(',')
    )
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`
}
