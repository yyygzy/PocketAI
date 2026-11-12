// 产物 IPC 参数契约（v67）
import { z } from 'zod'

/** 产物 id 是 randomUUID（36 位）；下限放宽到 8，避免测试/迁移数据用短 id 时误拒 */
export const artifactIdSchema = z.string().min(8).max(64)

/** 列表筛选：不带参数 = 全部；带会话 id = 只看该会话 */
export const artifactConversationIdSchema = z.string().min(1).max(64).nullable().optional()
