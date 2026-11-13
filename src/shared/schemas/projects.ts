// 多文件项目 IPC 参数契约（v70）
import { z } from 'zod'

/** 项目 id 是 randomUUID（36 位）；下限放宽到 8，避免测试数据用短 id 时误拒 */
export const projectIdSchema = z.string().min(8).max(64)

/**
 * 工作目录项目的绝对路径入参（打开目录 / 打包 ZIP）。
 * 这里只做形状校验；**是否真的落在工作目录内**由主进程 resolveWorkspaceAbsDir 重新判定，
 * 不靠渲染层自觉。
 */
export const projectAbsDirSchema = z.string().min(1).max(1024)
