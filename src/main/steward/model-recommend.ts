// 平台管家 · 模型推荐
//
// 根据硬件画像（内存 / GPU 显存 / CUDA / MPS / 磁盘剩余）给出本地模型档位建议，
// 并探测本机 Ollama（http://localhost:11434/api/tags）中已安装的模型。
// 纯规则实现，零外部依赖；在线模型仅给文字建议，不做任何下载。

import type { HardwareInfo, ModelPick, ModelRecommendation } from '../../shared/types'
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

interface TierRule {
  tier: string
  summary: string
  picks: Array<{ id: string; reason: string }>
}

export function pickByHardware(hw: HardwareInfo): TierRule {
  const memGB = hw.memory.total / GB
  const nvidia = hw.gpus.find((g) => g.cuda)
  const vramGB = nvidia?.memory ? nvidia.memory / GB : 0
  const hasMps = hw.gpus.some((g) => g.mps)

  // 1) NVIDIA 独显：以显存为准
  if (nvidia) {
    if (vramGB >= 24) {
      return {
        tier: '旗舰',
        summary: `检测到 ${nvidia.name}（显存 ≥24GB），可流畅运行 32B 量化模型，复杂推理建议尝试 DeepSeek-R1。`,
        picks: [
          { id: 'qwen2.5:32b-instruct-q4_K_M', reason: '32B 量化首选，综合能力强，24GB 显存可全程 GPU' },
          { id: 'deepseek-r1:14b', reason: '推理专精模型，适合代码/数学/复杂分析' },
          { id: 'qwen2.5:14b-instruct-q5_K_M', reason: '高质量日常对话备选，速度与质量平衡' }
        ]
      }
    }
    if (vramGB >= 12) {
      return {
        tier: '高性能',
        summary: `检测到 ${nvidia.name}（显存 ≥12GB），14B 量化模型可全程 GPU，体验接近云端。`,
        picks: [
          { id: 'qwen2.5:14b-instruct-q5_K_M', reason: '14B 首选，长文理解与指令遵循表现优秀' },
          { id: 'deepseek-r1:7b', reason: '轻量推理模型，复杂任务可开启思维链' },
          { id: 'qwen2.5:7b-instruct', reason: '追求速度时的日常对话备选' }
        ]
      }
    }
    if (vramGB >= 6) {
      return {
        tier: '主流',
        summary: `检测到 ${nvidia.name}（显存约 ${Math.round(vramGB)}GB），7B 量化模型可全程 GPU，性价比最高的档位。`,
        picks: [
          { id: 'qwen2.5:7b-instruct-q4_K_M', reason: '7B 量化首选，6GB+ 显存流畅运行' },
          { id: 'llama3.1:8b-instruct-q4_K_M', reason: '英文场景与通用能力备选' },
          { id: 'deepseek-r1:1.5b', reason: '极速推理小模型，适合简单分析任务' }
        ]
      }
    }
    return {
      tier: '入门',
      summary: `检测到 ${nvidia.name} 但显存偏小（<6GB 或未识别），建议 3B 级量化模型，部分层可卸载到 GPU。`,
      picks: [
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: '3B 量化，小显存友好，中文表现好' },
        { id: 'llama3.2:3b-instruct-q4_K_M', reason: '轻量通用备选' },
        { id: 'qwen2.5:1.5b', reason: '极低显存/纯 CPU 应急选择' }
      ]
    }
  }

  // 2) Apple Silicon：统一内存 = 物理内存，走 MPS/Metal
  if (hasMps) {
    if (memGB >= 32) {
      return {
        tier: '旗舰',
        summary: 'Apple Silicon（统一内存 ≥32GB），Metal 加速可运行 32B 量化模型。',
        picks: [
          { id: 'qwen2.5:32b-instruct-q4_K_M', reason: '32B 量化，Metal 加速' },
          { id: 'qwen2.5:14b-instruct-q5_K_M', reason: '高质量日常对话' },
          { id: 'deepseek-r1:14b', reason: '推理专精备选' }
        ]
      }
    }
    if (memGB >= 16) {
      return {
        tier: '高性能',
        summary: 'Apple Silicon（统一内存 ≥16GB），14B 量化模型体验良好。',
        picks: [
          { id: 'qwen2.5:14b-instruct-q4_K_M', reason: '14B 量化首选，Metal 加速' },
          { id: 'qwen2.5:7b-instruct', reason: '速度优先备选' },
          { id: 'deepseek-r1:7b', reason: '轻量推理模型' }
        ]
      }
    }
    return {
      tier: '主流',
      summary: 'Apple Silicon（统一内存 <16GB），建议 7B 及以下量化模型。',
      picks: [
        { id: 'qwen2.5:7b-instruct-q4_K_M', reason: '7B 量化首选，Mac 8GB 也可运行' },
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: '更流畅的轻量选择' },
        { id: 'llama3.2:3b', reason: '英文轻量备选' }
      ]
    }
  }

  // 3) 纯 CPU（含未识别到 GPU 的情况）
  if (memGB >= 32) {
    return {
      tier: '高性能（CPU）',
      summary: '未检测到独立 GPU，但内存充足（≥32GB）：可跑 14B 量化（速度偏慢），日常推荐 7B。',
      picks: [
        { id: 'qwen2.5:7b-instruct-q4_K_M', reason: 'CPU 日常首选，速度与质量平衡' },
        { id: 'qwen2.5:14b-instruct-q4_K_M', reason: '耐心等待可换更高质量（建议配 SSD）' },
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: '追求响应速度时使用' }
      ]
    }
  }
  if (memGB >= 16) {
    return {
      tier: '主流（CPU）',
      summary: '纯 CPU 环境、内存 16GB 左右：7B 量化模型可正常使用，3B 级更流畅。',
      picks: [
        { id: 'qwen2.5:7b-instruct-q4_K_M', reason: 'CPU 首选 7B 量化' },
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: '更快的轻量备选' },
        { id: 'llama3.2:3b', reason: '英文轻量备选' }
      ]
    }
  }
  if (memGB >= 8) {
    return {
      tier: '入门（CPU）',
      summary: '纯 CPU 环境、内存 8–16GB：建议 3B 级量化模型，复杂任务请使用在线模型。',
      picks: [
        { id: 'qwen2.5:3b-instruct-q4_K_M', reason: '3B 量化，低内存机器首选' },
        { id: 'llama3.2:3b-instruct-q4_K_M', reason: '轻量通用备选' },
        { id: 'qwen2.5:1.5b', reason: '后台常驻/极速响应场景' }
      ]
    }
  }
  return {
    tier: '低配置',
    summary: '内存低于 8GB 且无可用 GPU：仅推荐 1.5B–3B 小模型，强烈建议搭配在线模型使用。',
    picks: [
      { id: 'qwen2.5:1.5b', reason: '超轻量，老旧设备也能运行' },
      { id: 'llama3.2:1b', reason: '最低配置应急选择' },
      { id: 'qwen2.5:3b-instruct-q4_K_M', reason: '内存允许时可尝试 3B' }
    ]
  }
}

export async function recommendModels(): Promise<ModelRecommendation> {
  const hw = getHardwareInfo()
  const rule = pickByHardware(hw)
  const ollama = await probeOllamaModels()

  const localPicks: ModelPick[] = rule.picks.map((p, i) => ({
    id: p.id,
    tag: i === 0 ? '首选' : '备选',
    reason: p.reason,
    installed: isInstalled(ollama.models, p.id)
  }))

  // 知识库向量模型建议（轻量、CPU 可跑）
  const embedPick: ModelPick = {
    id: 'bge-m3',
    tag: '向量',
    reason: '知识库 Embedding 推荐：多语言、1024 维，CPU 也能跑；已安装 nomic-embed-text 可继续使用',
    installed: isInstalled(ollama.models, 'bge-m3') || isInstalled(ollama.models, 'nomic-embed-text')
  }
  localPicks.push(embedPick)

  const warnings: string[] = []
  const memGB = hw.memory.total / GB
  if (memGB < 8) warnings.push('内存低于 8GB，运行本地模型可能影响其他应用，建议优先使用在线模型')
  if (!hw.gpus.some((g) => g.cuda || g.mps)) warnings.push('未检测到 CUDA / MPS GPU，本地推理将使用 CPU，速度较慢')
  if (hw.disk.freeSpace != null && hw.disk.freeSpace < 10 * GB) {
    warnings.push('磁盘剩余空间不足 10GB，拉取模型前请先清理空间（7B 量化约需 5GB）')
  }
  if (!ollama.running) warnings.push('未检测到运行中的 Ollama 服务：安装并启动 Ollama 后即可拉取上述模型')

  const lowEnd = /入门|低配/.test(rule.tier)
  const onlineHint = lowEnd
    ? '本机算力有限：建议在「设置 → 模型提供商」配置在线 API（如 DeepSeek、通义千问、OpenAI 兼容接口），复杂任务走云端。'
    : '本地模型可覆盖日常对话；超长文本、复杂推理或多模态任务可随时切换到在线模型。'

  return {
    tier: rule.tier,
    summary: rule.summary,
    localPicks,
    onlineHint,
    ollamaRunning: ollama.running,
    installedModels: ollama.models,
    warnings
  }
}
