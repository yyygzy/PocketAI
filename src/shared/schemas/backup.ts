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

/**
 * WebDAV 口令能否被真正用于认证（SEC-37，实测划线）。
 *
 * 底层 webdav 包用 btoa 版 base64 预置 Basic 头，只能编 U+0000–U+00FF；超出范围时
 * `createClient` 当场抛 `The string to be encoded contains characters outside of the
 * Latin1 range`，请求根本不发出（Digest 路径也被这层预置头一起拖死）。
 * 所以划线依据是「能否被编码」而不是「是否 ASCII」——é / ü / ñ 这类实际是可用的，
 * 按纯 ASCII 拦会误杀。
 *
 * 只用于**用户新输入或改动**的口令：历史存下的超范围口令不回头锁死（见 handlers/backup.ts
 * 的 SAVE 分支——掩码回填视为未改动）。
 */
export const WEBDAV_PASSWORD_MAX_CODE_POINT = 0xff

/** 主进程侧的兜底文案（渲染层有自己的四语文案；直接走 IPC 的调用方拿这句） */
export const WEBDAV_PASSWORD_CHARSET_MSG =
  'WebDAV 密码不支持中文、emoji 等非拉丁字符（底层按 Latin1 编码认证头），请改用云盘生成的应用专用密码。'

export function isWebdavPasswordUsable(password: string): boolean {
  for (const ch of password) {
    if ((ch.codePointAt(0) ?? 0) > WEBDAV_PASSWORD_MAX_CODE_POINT) return false
  }
  return true
}

/** 定时备份计划 patch */
export const backupSchedulePatchSchema = z.object({
  enabled: z.boolean().optional(),
  intervalHours: z.number().int().positive().optional(),
  retentionCount: z.number().int().min(0).max(100).optional()
})

/** 合并执行入参 */
export const mergeExecutePayloadSchema = z.object({
  filename: backupFilenameSchema,
  strategy: z.enum(['local', 'cloud', 'newer']),
  backupPassword: z.string().min(1).optional()
})

/**
 * 本地恢复入参（SEC-6）：只接受主进程签发的 restoreToken + 可选备份密码。
 * 曾接受的 filePath 字段已移除——那让渲染端能用任意路径触发整库替换。
 */
export const backupRestoreArgsSchema = z.object({
  restoreToken: z.string().min(1).max(64).optional(),
  backupPassword: z.string().min(1).max(512).optional()
})
