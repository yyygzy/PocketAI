// 用量计价配置 zod 校验（IPC 入参边界）
import { z } from 'zod'

/** 非负有限数（允许 0 与小数单价；Infinity/NaN/负数拒绝） */
const nonNegPrice = z.number().finite().gte(0)

export const modelPriceSchema = z
  .object({
    input: nonNegPrice,
    output: nonNegPrice,
    cache: nonNegPrice.optional()
  })
  .strict()

export const usagePricingSchema = z
  .object({
    currency: z.enum(['CNY', 'USD']),
    prices: z.record(z.string(), modelPriceSchema)
  })
  .strict()

export type UsagePricingInput = z.infer<typeof usagePricingSchema>
