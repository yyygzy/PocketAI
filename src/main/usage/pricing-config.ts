// 用量计价配置 KV 读写（app_config，缺省人民币与空价表）
import { appConfigRepo } from '../db/repositories/app-config.repo'
import type { UsagePricing } from '../../shared/types'
import { parsePricing } from './pricing'

const K_USAGE_PRICING = 'usage.pricing'

/** 读取计价配置；无配置/坏 JSON 时回退 {currency:'CNY', prices:{}} */
export function getUsagePricing(): UsagePricing {
  const raw = appConfigRepo.get(K_USAGE_PRICING)
  if (!raw) return { currency: 'CNY', prices: {} }
  try {
    return parsePricing(JSON.parse(raw))
  } catch {
    return { currency: 'CNY', prices: {} }
  }
}

/** 持久化计价配置（调用方应已过 zod/parsePricing 清洗） */
export function setUsagePricing(pricing: UsagePricing): void {
  appConfigRepo.set(K_USAGE_PRICING, JSON.stringify(pricing))
}
