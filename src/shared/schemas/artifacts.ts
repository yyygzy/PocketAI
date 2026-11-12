// 产物 IPC 参数契约（v67）
import { z } from 'zod'

/** 产物 id 是 randomUUID（36 位）；下限放宽到 8，避免测试/迁移数据用短 id 时误拒 */
export const artifactIdSchema = z.string().min(8).max(64)

/** 列表筛选：不带参数 = 全部；带会话 id = 只看该会话 */
export const artifactConversationIdSchema = z.string().min(1).max(64).nullable().optional()

/**
 * 导出 PDF 的自包含 HTML 上限：md 正文工具上限 2MB，渲染成 HTML 后带标签/高亮，
 * 按 8 倍余量给 16M 字符。超限直接拒（safeHandle 转 `{ok:false}`），不截断。
 */
export const ARTIFACT_PDF_HTML_MAX_CHARS = 16 * 1024 * 1024
export const artifactPdfHtmlSchema = z.string().min(1).max(ARTIFACT_PDF_HTML_MAX_CHARS)
