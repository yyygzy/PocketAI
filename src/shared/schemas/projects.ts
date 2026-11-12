// 多文件项目 IPC 参数契约（v70）
import { z } from 'zod'

/** 项目 id 是 randomUUID（36 位）；下限放宽到 8，避免测试数据用短 id 时误拒 */
export const projectIdSchema = z.string().min(8).max(64)
