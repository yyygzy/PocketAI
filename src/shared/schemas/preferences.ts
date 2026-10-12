// 偏好设置 IPC 入参 schema
import { z } from 'zod'
import { DEFAULT_SIDEBAR_ORDER, MAX_PINNED_SIDEBAR_MODULES } from '../types'
import type { SidebarModuleId } from '../types'

/** UI_SET_PREFS 入参：Partial<UiPreferences>
 *  customCss 不在此设 max：服务层 setUiPreferences 统一截断到 MAX_CSS_LENGTH(200KB)，
 *  截断语义（不报错）是既有设计，schema 拒绝会改变该行为。 */
export const uiPrefsPatchSchema = z.object({
  opacity: z.number().min(0.6).max(1).optional(),
  customCss: z.string().optional(),
  chatFontSize: z.enum(['small', 'medium', 'large']).optional(),
  /** 代码块折叠阈值（行）：0 = 永不折叠，上限 200 防误填 */
  codeCollapseLines: z.number().int().min(0).max(200).optional(),
  /** Agent 模块「上次用在哪」：空串=清除（渲染端在切换/删除后回写） */
  agentAssistantId: z.string().max(128).optional(),
  agentConversationId: z.string().max(128).optional()
})

/**
 * 模块清单只允许有一份真相：`DEFAULT_SIDEBAR_ORDER`。
 * 这里曾手写 11 项枚举、漏掉 `'terminal'`（实际 12 个模块），后果是任何合法顺序都被
 * schema 拒掉 ⇒ `setSidebarOrder` 永远返回失败并被前端回滚，**侧栏拖拽排序从未生效**。
 * 派生自常量 + 下面那条「默认顺序必须自通过」的用例，一起防住第二次漂移。
 */
const sidebarModuleSchema = z.enum(
  DEFAULT_SIDEBAR_ORDER as [SidebarModuleId, ...SidebarModuleId[]]
)

/** SIDEBAR_SET_ORDER 入参：必须是全部模块的一个排列 */
export const sidebarOrderSchema = z
  .array(sidebarModuleSchema)
  .refine(
    (arr) =>
      arr.length === DEFAULT_SIDEBAR_ORDER.length && new Set(arr).size === DEFAULT_SIDEBAR_ORDER.length,
    '侧栏顺序必须是全部模块的一个排列'
  )

/** SIDEBAR_SET_PINNED 入参：固定不被休眠的模块子集（去重，数量不超过保活名额） */
export const sidebarPinnedSchema = z
  .array(sidebarModuleSchema)
  .max(MAX_PINNED_SIDEBAR_MODULES)
  .refine((arr) => new Set(arr).size === arr.length, '固定列表不能有重复模块')
