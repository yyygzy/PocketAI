// 沙箱 IPC 入参 schema
// html 会写入本地文件并加载进沙箱窗口：sandbox-service 按字节 256KB 复核（最终硬界），
// schema 层按字符对齐预检（UTF-8 多字节字符的字节数 ≥ 字符数，故字符上限不会放大字节面）。
// name/icon/description 落库渲染，与服务层 MAX_NAME_CHARS/MAX_DESC_CHARS 对齐。
import { z } from 'zod'

/** 与 `sandbox-service.ts` 的 MAX_HTML_BYTES（256KB）对齐的字符级预检 */
export const SANDBOX_MAX_HTML_CHARS = 256 * 1024
/** 名称与描述的上限同时给界面输入框用（§326：闸门数字只有一份出处，界面不再抄第二份） */
export const SANDBOX_MAX_NAME_CHARS = 60
export const SANDBOX_MAX_DESC_CHARS = 200
const SANDBOX_MAX_ICON_CHARS = 100
const SANDBOX_MAX_ID_CHARS = 64

/**
 * SANDBOX_CREATE 入参。
 * §326：名称**没有下限**——界面那句「名称（可留空）」是主进程 `cleanName` 的默认名「未命名」撑起来的，
 * 改前这里和 service 各有一道 `min(1)`，留空保存必失败（同 §323-D 那族：界面邀请、闸门挡死）。
 * 上限保留，并由输入框的 `maxLength` 在打字时就拦住。
 */
export const sandboxCreateSchema = z.object({
  name: z.string().max(SANDBOX_MAX_NAME_CHARS),
  html: z.string().max(SANDBOX_MAX_HTML_CHARS, 'HTML 内容超过 256KB 上限'),
  opts: z.object({
    icon: z.string().max(SANDBOX_MAX_ICON_CHARS).optional(),
    description: z.string().max(SANDBOX_MAX_DESC_CHARS).optional(),
    isApp: z.boolean().optional()
  }).optional()
})

/** SANDBOX_UPDATE_META 入参 */
export const sandboxUpdateMetaSchema = z.object({
  id: z.string().min(1).max(SANDBOX_MAX_ID_CHARS),
  patch: z.object({
    name: z.string().max(SANDBOX_MAX_NAME_CHARS).optional(),
    icon: z.string().max(SANDBOX_MAX_ICON_CHARS).optional(),
    description: z.string().max(SANDBOX_MAX_DESC_CHARS).optional(),
    isApp: z.boolean().optional()
  })
})
