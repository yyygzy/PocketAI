// 备份模块 IPC 入参 schema
// 风险点：WebDAV 备份文件名（拼接远端路径）、WebDAV 配置（URL/凭据）。
import { z } from 'zod'
import { safeFileName } from './files'

/** WebDAV 备份文件名（远端）：复用安全文件名规则，防路径注入 */
export const backupFilenameSchema = safeFileName

/** WebDAV 配置 */
export const webdavConfigSchema = z.object({
  url: z.string().url('WebDAV URL 不合法'),
  username: z.string(),
  passwordCipher: z.string(),
  directory: z.string().default('')
})

/** 定时备份计划 patch */
export const backupSchedulePatchSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().positive().optional()
})

/** 合并执行入参 */
export const mergeExecutePayloadSchema = z.object({
  filename: backupFilenameSchema,
  strategy: z.enum(['local', 'cloud', 'newer'])
})
