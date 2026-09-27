// Assistant 配置 IPC 入参 schema
// ASSISTANT_SAVE 入参为 Partial<AssistantRecord> & { name: string }：
// 新建/编辑助手时只传变更字段，name 必填。
// systemPrompt 直接进入 LLM 请求，welcomeMessage/description 落库并渲染，
// 均为渲染层可触达的不可信输入，统一带资源上限。
import { z } from 'zod'

// ─── 资源上限（宽松，正常使用不可达） ────────────────────────────
const ASST_MAX_NAME_CHARS = 100
const ASST_MAX_DESC_CHARS = 500
/** avatar 为 emoji 或短标识（默认 🤖），不支持图片 data URL */
const ASST_MAX_AVATAR_CHARS = 100
/** system prompt 上限：覆盖长提示词场景（约 5 万汉字） */
const ASST_MAX_SYSTEM_PROMPT_CHARS = 100_000
const ASST_MAX_WELCOME_CHARS = 2000
const ASST_MAX_ID_CHARS = 64
/** 工具权限/技能/知识库 ID 列表数量上限 */
const ASST_MAX_REF_ITEMS = 100
const ASST_MAX_PARAMS_ENTRIES = 20

/** AssistantRecord 完整字段（用于派生 partial save schema） */
const assistantRecordFull = z.object({
  id: z.string().min(1).max(ASST_MAX_ID_CHARS),
  name: z.string().min(1).max(ASST_MAX_NAME_CHARS),
  description: z.string().max(ASST_MAX_DESC_CHARS),
  avatar: z.string().max(ASST_MAX_AVATAR_CHARS),
  systemPrompt: z.string().max(ASST_MAX_SYSTEM_PROMPT_CHARS),
  defaultProviderId: z.string().max(ASST_MAX_ID_CHARS).nullable(),
  defaultModel: z.string().max(200).nullable(),
  defaultParams: z
    .record(z.string().max(64), z.unknown())
    .nullable()
    .superRefine((rec, ctx) => {
      if (rec && Object.keys(rec).length > ASST_MAX_PARAMS_ENTRIES) {
        ctx.addIssue({
          code: 'custom',
          message: `默认参数不能超过 ${ASST_MAX_PARAMS_ENTRIES} 项`
        })
      }
    }),
  toolPermissions: z.array(z.string().max(200)).max(ASST_MAX_REF_ITEMS),
  skillIds: z.array(z.string().max(ASST_MAX_ID_CHARS)).max(ASST_MAX_REF_ITEMS),
  knowledgeBaseIds: z.array(z.string().max(ASST_MAX_ID_CHARS)).max(ASST_MAX_REF_ITEMS),
  welcomeMessage: z.string().max(ASST_MAX_WELCOME_CHARS),
  isBuiltin: z.boolean(),
  isPinned: z.boolean(),
  createdAt: z.number().int().nonnegative()
})

/** ASSISTANT_SAVE 入参 */
export const assistantSaveSchema = assistantRecordFull
  .partial()
  .extend({ name: z.string().min(1).max(ASST_MAX_NAME_CHARS) })

/** ASSISTANT_SET_PINNED 第二参 */
export const booleanSchema = z.boolean()
