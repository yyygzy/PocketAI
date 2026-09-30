// 会话批量导出共用核心：选中集截断 + 逐会话组装导出文件 + 主进程写盘收尾。
// 抽自 ChatModule/AgentPanel 两份几乎相同的 handleBatchExport 循环（V4-Iter-17 批量导出、本批多选共用）。
import type { ConversationRecord, MessageRecord } from '../../../shared/types'
import { safeFileName, buildConversationMarkdown } from '../../../shared/export-markdown'
import { buildConversationHtml } from './export-html'

/** 导出格式 */
export type BatchExportFormat = 'md' | 'html'

/** 单个导出文件（与 CONVERSATION_EXPORT_BATCH IPC 的 files 元素同构） */
export interface BatchExportFile {
  name: string
  content: string
}

/** 主进程批量写盘结果 */
export interface BatchExportResult {
  canceled?: boolean
  ok?: boolean
  error?: string
  count?: number
  dir?: string
  failed?: string[]
}

/** IPC files 数量上限（conversations.ts handler 同值） */
export const BATCH_EXPORT_MAX = 500

/**
 * 选中集截断：超上限保留前 max 个（按列表显示顺序），返回被忽略数量供 UI 提示。
 */
export function capSelection(
  convs: ConversationRecord[],
  max: number = BATCH_EXPORT_MAX
): { list: ConversationRecord[]; dropped: number } {
  if (convs.length <= max) return { list: convs, dropped: 0 }
  return { list: convs.slice(0, max), dropped: convs.length - max }
}

/**
 * 逐会话组装导出文件：listMessages 拉消息 → MD/HTML 渲染 → 每 10 个让出一帧
 * （同步渲染管线尤其 HTML 会阻塞 UI）。listMessages/resolveAssistantName 参数化，node 测试可 stub。
 */
export async function buildBatchExportFiles(opts: {
  convs: ConversationRecord[]
  format: BatchExportFormat
  /** 会话消息拉取（生产传 window.pocketai.listMessages） */
  listMessages: (convId: string) => Promise<MessageRecord[]>
  /** 助手名解析（导出文档标题用，无对应返回 null） */
  resolveAssistantName: (assistantId: string | null) => string | null
  /** 每完成一个会话回调（进度提示用） */
  onProgress?: (done: number, total: number) => void
}): Promise<BatchExportFile[]> {
  const { convs, format, listMessages, resolveAssistantName, onProgress } = opts
  const files: BatchExportFile[] = []
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i]!
    const msgs = await listMessages(c.id)
    const assistantName = resolveAssistantName(c.assistantId ?? null)
    const content =
      format === 'html'
        ? await buildConversationHtml(c, msgs, assistantName)
        : buildConversationMarkdown(c, msgs, assistantName)
    files.push({ name: `${safeFileName(c.title)}.${format}`, content })
    onProgress?.(i + 1, convs.length)
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0))
  }
  return files
}

/** 批量写盘收尾结果（调用方按 kind 拼 toast，toast 为 React context 不能在此直调） */
export type BatchExportOutcome =
  | { kind: 'canceled' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; count: number; dir: string; failedCount: number }

/**
 * 调主进程批量写盘并归一化结果（canceled / failed / done）。
 */
export async function finishBatchExport(files: BatchExportFile[]): Promise<BatchExportOutcome> {
  const r = (await window.pocketai.exportConversationsBatch(files)) as BatchExportResult
  if (r.canceled) return { kind: 'canceled' }
  if (!r.ok) return { kind: 'failed', error: r.error ?? '' }
  return { kind: 'done', count: r.count ?? 0, dir: r.dir ?? '', failedCount: r.failed?.length ?? 0 }
}
