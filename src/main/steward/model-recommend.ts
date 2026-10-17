// 平台管家 · 模型推荐
//
// 根据硬件画像（内存 / GPU 显存 / CUDA / MPS / 磁盘剩余）给出本地模型档位建议，
// 并探测本机 Ollama（http://localhost:11434/api/tags）中已安装的模型。
// 纯规则实现，零外部依赖；在线模型仅给文字建议，不做任何下载。
//
// V4-Iter-156：这里**只出码 + 参数**，一句界面文案都不写（码表在 `shared/model-rec-codes.ts`）。
// 以前这张表的 60 条中文串（8 档位名 + 11 句硬件总结 + 3 个标签值 + 32 条推荐语 + 4 条告警
// + 2 条在线建议）直接进 IPC 返回值 ⇒ en / ja / ko 界面读到整句中文，而档位名与硬件总结
// 还显示在**首启向导**那一屏（`FirstRunWizard.tsx:362,416`）——新用户第一眼就是中英夹排。

import type { HardwareInfo, ModelPick, ModelRecommendation } from '../../shared/types'
import type {
  ModelOnlineHintCode,
  ModelPickTagCode,
  ModelReasonCode,
  ModelSummaryCode,
  ModelTierCode,
  ModelWarnCode
} from '../../shared/model-rec-codes'
import { isLowEndTier } from '../../shared/model-rec-codes'
import { getHardwareInfo } from './hardware'

const GB = 1024 * 1024 * 1024
const OLLAMA_TAGS_URL = 'http://localhost:11434/api/tags'
const PROBE_TIMEOUT_MS = 2500

interface OllamaTag {
  name: string
  size?: number
}

/** 探测本机已安装的 Ollama 模型；服务未运行时返回 null */
async function probeOllamaModels(): Promise<{ running: boolean; models: string[] }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  try {
    const res = await fetch(OLLAMA_TAGS_URL, { signal: controller.signal })
    if (!res.ok) return { running: true, models: [] }
    const data = (await res.json()) as { models?: OllamaTag[] }
    return { running: true, models: (data.models ?? []).map((m) => m.name) }
  } catch {
    return { running: false, models: [] }
  } finally {
    clearTimeout(timer)
  }
}

/** 已安装匹配：tag 精确相等，或本地以 "name:" 开头（同模型不同量化版本） */
export function isInstalled(installed: string[], name: string): boolean {
  const base = name.split(':')[0]!.toLowerCase()
  return installed.some((m) => {
    const x = m.toLowerCase()
    return x === name.toLowerCase() || x.startsWith(base + ':')
  })
}

/**
 * 知识库向量模型那条推荐由 `recommendModels` 追加，**不在硬件分支表里** ⇒
 * 单列出来给用例（`tests/model-recommend-codes.test.ts`）并进"实际产出的码"，
 * 免得测试用正则扫源码来猜它存在（那种断言一改写法就假绿）。
 */
export const KB_EMBED_MODEL_ID = 'bge-m3'
export const KB_EMBED_REASON: ModelReasonCode = 'bge_m3_kb'
export const KB_EMBED_TAG: ModelPickTagCode = 'embedding'

interface TierRule {
  tier: ModelTierCode
  summary: ModelSummaryCode
  /** 总结句的插值：GPU 名只有主进程知道；显存阈值是分支常量 ⇒ 写在字典文案里，不当参数漂 */
  summaryParams: Record<string, string | number>
  picks: Array<{ id: string; reason: ModelReasonCode }>
}

/**
 * 硬件 → 档位建议。**同一个码可以在多个分支复用，但只在文案真的相同时**
 * （例：`llama32_3b_general`「轻量通用备选」出现在 NVIDIA 入门档与 CPU 8GB 档，
 * 而 Apple Silicon 那句"高质量日常对话"与 NVIDIA 那句"高质量日常对话备选，速度与质量平衡"
 * 不是一句 ⇒ 分开两个码）。`tests/model-recommend-codes.test.ts` 逐分支跑这张表核对码清单，
 * 加档位/加推荐而漏登记时用例红，而不是界面上出现裸码。
 */
export function pickByHardware(hw: HardwareInfo): TierRule {
  const memGB = hw.memory.total / GB
  const nvidia = hw.gpus.find((g) => g.cuda)
  const vramGB = nvidia?.memory ? nvidia.memory / GB : 0
  const hasMps = hw.gpus.some((g) => g.mps)

  // 1) NVIDIA 独显：以显存为准
  if (nvidia) {
    if (vramGB >= 24) {
      return {
        tier: 'flagship',
        summary: 'nv_flagship',
        summaryParams: { gpu: nvidia.name },
        picks: [
          { id: 'qwen2.5:32b-instruct-q4_K_M', reason: 'qwen32b_24g' },
          { id: 'deepseek-r1:14b', reason: 'deepseek_r1_14b_reasoning' },
          { id: 'qwen2.5:14b-instruct-q5_K_M', reason: 'qwen14b_q5_daily' }
        ]
      }
    }
    if (vramGB >= 12) {
      return {
        tier: 'high',
        summary: 'nv_high',
        summaryParams: { gpu: nvidia.name },
        picks: [
          { id: 'qwen2.5:14b-instruct-q5_K_M', reason: 'qwen14b_q5_longctx' },
          { id: 'deepseek-r1:7b', reason: 'deepseek_r1_7b_thinking' },
          { id: 'qwen2.5:7b-instruct', reason: 'qwen7b_speed_daily' }
        ]
      }
    }
    if (vramGB >= 6) {
      return {
        tier: 'mainstream',
        summary: 'nv_mainstream',
        summaryParams: { gpu: nvidia.name, vram: Math.round(vramGB) },
        picks: [
          { id: 'qwen2.5:7b-instruct-q4_K_M', reason: 'qwen7b_q4_6g' },
          { id: 'llama3.1:8b-instruct-q4_K_M', reason: 'llama31_8b_english' },
          { id: 'deepseek-r1:1.5b', reason: 'deepseek_r1_15b_fast' }
        ]
      }
    }
    return {
      tier: 'entry',
      summary: 'nv_entry',
      summaryParams: { gpu: nvidia.name },
      picks: [
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: 'qwen3b_q4_lowvram' },
        { id: 'llama3.2:3b-instruct-q4_K_M', reason: 'llama32_3b_general' },
        { id: 'qwen2.5:1.5b', reason: 'qwen15b_emergency' }
      ]
    }
  }

  // 2) Apple Silicon：统一内存 = 物理内存，走 MPS/Metal
  if (hasMps) {
    if (memGB >= 32) {
      return {
        tier: 'flagship',
        summary: 'mps_flagship',
        summaryParams: {},
        picks: [
          { id: 'qwen2.5:32b-instruct-q4_K_M', reason: 'qwen32b_mps' },
          { id: 'qwen2.5:14b-instruct-q5_K_M', reason: 'qwen14b_daily_mps' },
          { id: 'deepseek-r1:14b', reason: 'deepseek_r1_14b_alt' }
        ]
      }
    }
    if (memGB >= 16) {
      return {
        tier: 'high',
        summary: 'mps_high',
        summaryParams: {},
        picks: [
          { id: 'qwen2.5:14b-instruct-q4_K_M', reason: 'qwen14b_q4_mps' },
          { id: 'qwen2.5:7b-instruct', reason: 'qwen7b_speed_alt' },
          { id: 'deepseek-r1:7b', reason: 'deepseek_r1_7b_light' }
        ]
      }
    }
    return {
      tier: 'mainstream',
      summary: 'mps_mainstream',
      summaryParams: {},
      picks: [
        { id: 'qwen2.5:7b-instruct-q4_K_M', reason: 'qwen7b_q4_mac8g' },
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: 'qwen3b_q4_smooth' },
        { id: 'llama3.2:3b', reason: 'llama32_3b_english_light' }
      ]
    }
  }

  // 3) 纯 CPU（含未识别到 GPU 的情况）
  if (memGB >= 32) {
    return {
      tier: 'high_cpu',
      summary: 'cpu_high',
      summaryParams: {},
      picks: [
        { id: 'qwen2.5:7b-instruct-q4_K_M', reason: 'qwen7b_q4_cpu_primary' },
        { id: 'qwen2.5:14b-instruct-q4_K_M', reason: 'qwen14b_q4_cpu_patience' },
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: 'qwen3b_q4_cpu_speed' }
      ]
    }
  }
  if (memGB >= 16) {
    return {
      tier: 'mainstream_cpu',
      summary: 'cpu_mainstream',
      summaryParams: {},
      picks: [
        { id: 'qwen2.5:7b-instruct-q4_K_M', reason: 'qwen7b_q4_cpu_pick' },
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: 'qwen3b_cpu_faster' },
        { id: 'llama3.2:3b', reason: 'llama32_3b_english_light' }
      ]
    }
  }
  if (memGB >= 8) {
    return {
      tier: 'entry_cpu',
      summary: 'cpu_entry',
      summaryParams: {},
      picks: [
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: 'qwen3b_q4_lowmem_primary' },
        { id: 'llama3.2:3b-instruct-q4_K_M', reason: 'llama32_3b_general' },
        { id: 'qwen2.5:1.5b', reason: 'qwen15b_background' }
      ]
    }
  }
  return {
    tier: 'low',
    summary: 'cpu_low',
    summaryParams: {},
    picks: [
      { id: 'qwen2.5:1.5b', reason: 'qwen15b_ultra_light' },
      { id: 'llama3.2:1b', reason: 'llama32_1b_last_resort' },
      { id: 'qwen2.5:3b-instruct-q4_K_M', reason: 'qwen3b_try_if_ram' }
    ]
  }
}

export async function recommendModels(): Promise<ModelRecommendation> {
  const hw = getHardwareInfo()
  const rule = pickByHardware(hw)
  const ollama = await probeOllamaModels()

  const localPicks: ModelPick[] = rule.picks.map((p, i) => ({
    id: p.id,
    tag: i === 0 ? 'primary' : 'alternate',
    reason: p.reason,
    installed: isInstalled(ollama.models, p.id)
  }))

  // 知识库向量模型建议（轻量、CPU 可跑）
  const embedPick: ModelPick = {
    id: KB_EMBED_MODEL_ID,
    tag: KB_EMBED_TAG,
    reason: KB_EMBED_REASON,
    installed: isInstalled(ollama.models, 'bge-m3') || isInstalled(ollama.models, 'nomic-embed-text')
  }
  localPicks.push(embedPick)

  const warnings: ModelWarnCode[] = []
  const memGB = hw.memory.total / GB
  if (memGB < 8) warnings.push('mem_lt8')
  if (!hw.gpus.some((g) => g.cuda || g.mps)) warnings.push('no_gpu_accel')
  if (hw.disk.freeSpace != null && hw.disk.freeSpace < 10 * GB) warnings.push('disk_lt10g')
  if (!ollama.running) warnings.push('no_ollama')

  // 低配档换另一句在线建议。156 之前这里是对**中文档位名**做正则（`/入门|低配/`），
  // 换措辞就会静默选错句子 ⇒ 现在按码判断言（`isLowEndTier`）。
  const onlineHint: ModelOnlineHintCode = isLowEndTier(rule.tier) ? 'low_end' : 'general'

  return {
    tier: rule.tier,
    summary: rule.summary,
    summaryParams: rule.summaryParams,
    localPicks,
    onlineHint,
    ollamaRunning: ollama.running,
    installedModels: ollama.models,
    warnings
  }
}
