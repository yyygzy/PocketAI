// Assistant 配置 IPC 入参 schema
// ASSISTANT_SAVE 入参为 Partial<AssistantRecord> & { name: string }：
// 新建/编辑助手时只传变更字段，name 必填。
import { z } from 'zod'

/** AssistantRecord 完整字段（用于派生 partial save schema） */
const assistantRecordFull = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  avatar: z.string(),
  systemPrompt: z.string(),
  defaultProviderId: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultParams: z.record(z.string(), z.unknown()).nullable(),
  toolPermissions: z.array(z.string()),
  skillIds: z.array(z.string()),
  knowledgeBaseIds: z.array(z.string()),
  welcomeMessage: z.string(),
  isBuiltin: z.boolean(),
  isPinned: z.boolean(),
  createdAt: z.number().int().nonnegative()
})

/** ASSISTANT_SAVE 入参 */
export const assistantSaveSchema = assistantRecordFull
  .partial()
  .extend({ name: z.string().min(1) })

/** ASSISTANT_SET_PINNED 第二参 */
export const booleanSchema = z.boolean()
