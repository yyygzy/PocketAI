// 偏好设置 IPC 入参 schema
import { z } from 'zod'

/** UI_SET_PREFS 入参：Partial<UiPreferences> */
export const uiPrefsPatchSchema = z.object({
  opacity: z.number().min(0.6).max(1).optional(),
  customCss: z.string().optional()
})

const sidebarModuleSchema = z.enum([
  'chat', 'agent', 'skills', 'knowledge', 'files',
  'notes', 'translate', 'image', 'sandbox', 'steward', 'settings'
])

/** SIDEBAR_SET_ORDER 入参：必须是全部模块的一个排列 */
export const sidebarOrderSchema = z
  .array(sidebarModuleSchema)
  .refine(
    (arr) => arr.length === 11 && new Set(arr).size === 11,
    '侧栏顺序必须是全部模块的一个排列'
  )
