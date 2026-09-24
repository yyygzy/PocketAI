// 沙箱 IPC 入参 schema
import { z } from 'zod'

/** SANDBOX_CREATE 入参 */
export const sandboxCreateSchema = z.object({
  name: z.string().min(1),
  html: z.string(),
  opts: z.object({
    icon: z.string().optional(),
    description: z.string().optional(),
    isApp: z.boolean().optional()
  }).optional()
})

/** SANDBOX_UPDATE_META 入参 */
export const sandboxUpdateMetaSchema = z.object({
  id: z.string().min(1),
  patch: z.object({
    name: z.string().optional(),
    icon: z.string().optional(),
    description: z.string().optional(),
    isApp: z.boolean().optional()
  })
})
