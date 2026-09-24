// 绘图 IPC 入参 schema
import { z } from 'zod'

const imageSizeSchema = z.enum([
  '512x512', '768x768', '1024x1024', '1024x1792', '1792x1024'
])

/** IMAGES_GENERATE 入参 */
export const imageGenerateSchema = z.object({
  requestId: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
  prompt: z.string().min(1, 'prompt 不能为空'),
  size: imageSizeSchema
})
