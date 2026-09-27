// 绘图 IPC 入参 schema
// prompt 原样进入图像生成 API（计费/token 面），带宽松上限（DALL·E 3 上限 4000）。
import { z } from 'zod'

const IMAGE_MAX_PROMPT_CHARS = 4000
const IMAGE_MAX_ID_CHARS = 64
const IMAGE_MAX_MODEL_CHARS = 200

const imageSizeSchema = z.enum([
  '512x512', '768x768', '1024x1024', '1024x1792', '1792x1024'
])

/** IMAGES_GENERATE 入参 */
export const imageGenerateSchema = z.object({
  requestId: z.string().min(1).max(IMAGE_MAX_ID_CHARS),
  providerId: z.string().min(1).max(IMAGE_MAX_ID_CHARS),
  model: z.string().min(1).max(IMAGE_MAX_MODEL_CHARS),
  prompt: z.string().min(1, 'prompt 不能为空').max(IMAGE_MAX_PROMPT_CHARS, 'prompt 过长（最多 4000 字符）'),
  size: imageSizeSchema
})
