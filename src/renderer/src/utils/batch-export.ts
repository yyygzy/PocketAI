// 会话批量导出共用核心：选中集截断 + 逐会话组装导出文件 + 主进程写盘收尾。
// 抽自 ChatModule/AgentPanel 两份几乎相同的 handleBatchExport 循环（V4-Iter-17 批量导出、本批多选共用）。
import type { ConversationRecord, MessageRecord } from '../../../shared/types'
import { safeFileName, buildConversationMarkdown } from '../../../shared/export-markdown'
import { buildConversationHtml } from './export-html'
import { hasIpcFailed } from './ipc'

/** 导出格式（pdf：content 仍为自包含 HTML，主进程 printToPDF 转换） */
export type BatchExportFormat = 'md' | 'html' | 'pdf'

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

/** 批量导出 PDF 上限（逐会话 printToPDF 耗时 ~1s/个，conversations.ts PDF_BATCH handler 同值） */
export const BATCH_PDF_MAX = 50

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

/** 逐会话组装的结果：文件 + **读不到消息的会话数**（§329：这一发过去没人判，整批停产还不说实话） */
export interface BatchBuildResult {
  files: BatchExportFile[]
  unreadable: number
}

/**
 * 逐会话组装导出文件：listMessages 拉消息 → MD/HTML 渲染 → 每 10 个让出一帧
 * （同步渲染管线尤其 HTML 会阻塞 UI）。listMessages/resolveAssistantName 参数化，node 测试可 stub。
 *
 * §329：`listMessages` 是**注入回调**，所以 §217 那道 AST 闸门看不见它（扫描器只认 `window.pocketai.`
 * 字面链根）——改前 `{ok:false}` 直接进渲染函数 ⇒ TypeError，整批停产、已构建的那些也一起丢，
 * toast 是一句天书。现在判失败面：坏会话跳过并计数，其余照常出货。
 */
export async function buildBatchExportFiles(opts: {
  convs: ConversationRecord[]
  format: BatchExportFormat
  /** 会话消息拉取（生产传 window.pocketai.listMessages；失败是 resolve 的 `{ok:false}`，不是 reject） */
  listMessages: (convId: string) => Promise<MessageRecord[] | { ok: false; error?: string }>
  /** 助手名解析（导出文档标题用，无对应返回 null） */
  resolveAssistantName: (assistantId: string | null) => string | null
  /** 每完成一个会话回调（进度提示用） */
  onProgress?: (done: number, total: number) => void
}): Promise<BatchBuildResult> {
  const { convs, format, listMessages, resolveAssistantName, onProgress } = opts
  const files: BatchExportFile[] = []
  let unreadable = 0
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i]!
    const msgs = await listMessages(c.id)
    if (hasIpcFailed(msgs)) {
      unreadable++
      onProgress?.(i + 1, convs.length)
      continue
    }
    const assistantName = resolveAssistantName(c.assistantId ?? null)
    const content =
      format === 'md'
        ? buildConversationMarkdown(c, msgs, assistantName)
        : await buildConversationHtml(c, msgs, assistantName)
    // pdf 的 content 仍为自包含 HTML，主进程 printToPDF 转换后按 .pdf 落盘
    const ext = format === 'pdf' ? 'pdf' : format
    files.push({ name: `${safeFileName(c.title)}.${ext}`, content })
    onProgress?.(i + 1, convs.length)
    if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0))
  }
  return { files, unreadable }
}

/** 批量写盘收尾结果（调用方按 kind 拼 toast，toast 为 React context 不能在此直调） */
export type BatchExportOutcome =
  | { kind: 'canceled' }
  | { kind: 'failed'; error: string }
  | { kind: 'done'; count: number; dir: string; failedCount: number }

/**
 * 收尾话术（两屏共用一份，§329）：
 *  · 一个都没落地 ⇒ 不许 `toast.success`——改前主进程回 `{ok:true,count:0,failed:[…]}`，
 *    绿色那句「已导出 0 个文件（N 个失败）」在替用户演成功；
 *  · 「会话读不到」与「文件写不进」是两件事，分开报数。
 */
export function reportBatchOutcome(
  toast: { success: (m: string) => void; error: (m: string) => void; info: (m: string) => void },
  t: (key: string, args?: Record<string, string | number>) => string,
  outcome: BatchExportOutcome,
  unreadable: number,
  unknownError: string
): void {
  const suffix = unreadable > 0 ? `（${t('chat.exportBatchUnreadable', { n: unreadable })}）` : ''
  if (outcome.kind === 'failed') {
    toast.error(t('chat.exportFail', { e: outcome.error || unknownError }) + suffix)
    return
  }
  if (outcome.kind === 'canceled') return
  if (outcome.count === 0) {
    // 一个都没出来 ⇒ 红的那句，数字取「写不进 + 读不到」两者之和（别把两笔账合成一笔谎）
    toast.error(t('chat.exportBatchAllFailed', { n: outcome.failedCount + unreadable }))
    return
  }
  const warn = outcome.failedCount > 0 ? `（${outcome.failedCount} ${t('chat.exportBatchFailed')}）` : ''
  toast.success(`${t('chat.exportBatchDone', { n: outcome.count, dir: outcome.dir })}${warn}${suffix}`)
}

/**
 * 调主进程批量写盘并归一化结果（canceled / failed / done）。
 * format==='pdf' 走 printToPDF 批量通道（上限 50），md/html 走既有通道。
 */
export async function finishBatchExport(
  files: BatchExportFile[],
  format: BatchExportFormat = 'md'
): Promise<BatchExportOutcome> {
  const r = (
    format === 'pdf'
      ? await window.pocketai.exportConversationsPdfBatch(files)
      : await window.pocketai.exportConversationsBatch(files)
  ) as BatchExportResult
  if (r.canceled) return { kind: 'canceled' }
  if (!r.ok) return { kind: 'failed', error: r.error ?? '' }
  return { kind: 'done', count: r.count ?? 0, dir: r.dir ?? '', failedCount: r.failed?.length ?? 0 }
}
