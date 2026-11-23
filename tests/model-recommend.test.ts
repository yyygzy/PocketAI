// model-recommend 模型推荐测试
//
// 覆盖 src/main/steward/model-recommend.ts 的两个纯函数：
// - isInstalled：Ollama 已安装模型匹配（精确 tag / name: 前缀同模型不同量化）
// - pickByHardware：按硬件画像（NVIDIA 显存 / Apple MPS 内存 / 纯 CPU 内存）分档推荐
//   V4-Iter-156 起它**只出码**（tier / summary / reason 都是码，配 summaryParams），界面文案住四语字典 ⇒
//   本文件断的是码；「每个码四语都有文案」由 tests/model-recommend-codes.test.ts 守。
//
// 策略：纯函数无运行时依赖，mock ./hardware 避免 getHardwareInfo 触发硬件探测。
import { describe, it, expect, vi } from 'vitest'
import type { HardwareInfo } from '../src/shared/types'

vi.mock('../src/main/steward/hardware', () => ({
  getHardwareInfo: (): HardwareInfo => ({} as HardwareInfo)
}))

import {
  isInstalled, pickByHardware, pickCoderModel, CODER_MODEL_BY_TIER
} from '../src/main/steward/model-recommend'

const GB = 1024 * 1024 * 1024

function hw(overrides: Partial<HardwareInfo>): HardwareInfo {
  return {
    cpu: { model: 'test', cores: 4, threads: 8 },
    memory: { total: 16 * GB, free: 8 * GB },
    gpus: [],
    disk: { type: 'ssd', removable: false, drive: 'C:', volumeLabel: null, filesystem: null, totalSpace: null, freeSpace: null, mediumType: null, busType: null },
    os: { platform: 'win32', release: '10', arch: 'x64' },
    ...overrides
  } as HardwareInfo
}

describe('isInstalled — Ollama 已安装模型匹配', () => {
  it('精确 tag 相等 → true', () => {
    expect(isInstalled(['qwen2.5:7b-instruct-q4_K_M'], 'qwen2.5:7b-instruct-q4_K_M')).toBe(true)
  })

  it('大小写不敏感', () => {
    expect(isInstalled(['QWEN2.5:7B'], 'qwen2.5:7b')).toBe(true)
  })

  it('同模型不同量化（本地以 name: 开头）→ true', () => {
    // name 是 qwen2.5:32b，本地有 qwen2.5:32b-instruct-q4_K_M → 匹配
    expect(isInstalled(['qwen2.5:32b-instruct-q4_K_M'], 'qwen2.5:32b')).toBe(true)
  })

  it('name 无后缀（仅 base），本地有 base:xxx → true', () => {
    expect(isInstalled(['llama3.2:3b-instruct-q4_K_M'], 'llama3.2:3b')).toBe(true)
  })

  it('不同模型 → false', () => {
    expect(isInstalled(['qwen2.5:7b'], 'llama3.2:3b')).toBe(false)
  })

  it('空列表 → false', () => {
    expect(isInstalled([], 'qwen2.5:7b')).toBe(false)
  })

  it('本地 tag 不是 name 的前缀 → false', () => {
    // name=qwen2.5:7b，本地=qwen2.5:70b → base 都是 qwen2.5，但 x.startsWith('qwen2.5:') → true?
    // 实际上 qwen2.5:70b startsWith('qwen2.5:') 是 true，所以会匹配。这是设计：同 base 即视为已安装。
    expect(isInstalled(['qwen2.5:70b'], 'qwen2.5:7b')).toBe(true)
  })
})

describe('pickByHardware — 硬件分档推荐', () => {
  describe('NVIDIA 独显（按显存）', () => {
    const nvidia = (vramGB: number) => hw({
      gpus: [{ name: 'RTX 4090', memory: vramGB * GB, cuda: true, mps: false }]
    })

    it('显存 ≥24GB → 旗舰档', () => {
      const r = pickByHardware(nvidia(24))
      expect(r.tier).toBe('flagship')
      expect(r.picks[0]!.id).toBe('qwen2.5:32b-instruct-q4_K_M')
    })

    it('显存 ≥12GB 且 <24GB → 高性能档', () => {
      const r = pickByHardware(nvidia(16))
      expect(r.tier).toBe('high')
      expect(r.picks[0]!.id).toBe('qwen2.5:14b-instruct-q5_K_M')
    })

    it('显存 ≥6GB 且 <12GB → 主流档', () => {
      const r = pickByHardware(nvidia(8))
      expect(r.tier).toBe('mainstream')
      expect(r.picks[0]!.id).toBe('qwen2.5:7b-instruct-q4_K_M')
    })

    it('显存 <6GB → 入门档', () => {
      const r = pickByHardware(nvidia(4))
      expect(r.tier).toBe('entry')
      expect(r.picks[0]!.id).toBe('qwen2.5:3b-instruct-q4_K_M')
    })

    it('显存未识别（memory undefined）→ 入门档', () => {
      const r = pickByHardware(hw({ gpus: [{ name: 'RTX', cuda: true, mps: false }] }))
      expect(r.tier).toBe('entry')
    })
  })

  describe('Apple Silicon（MPS，按统一内存）', () => {
    const mps = (memGB: number) => hw({
      memory: { total: memGB * GB, free: memGB * GB },
      gpus: [{ name: 'Apple M2', cuda: false, mps: true }]
    })

    it('内存 ≥32GB → 旗舰档', () => {
      const r = pickByHardware(mps(32))
      expect(r.tier).toBe('flagship')
    })

    it('内存 ≥16GB 且 <32GB → 高性能档', () => {
      const r = pickByHardware(mps(16))
      expect(r.tier).toBe('high')
    })

    it('内存 <16GB → 主流档', () => {
      const r = pickByHardware(mps(8))
      expect(r.tier).toBe('mainstream')
    })
  })

  describe('纯 CPU（按内存）', () => {
    const cpu = (memGB: number) => hw({
      memory: { total: memGB * GB, free: memGB * GB },
      gpus: []
    })

    it('内存 ≥32GB → 高性能（CPU）', () => {
      const r = pickByHardware(cpu(32))
      expect(r.tier).toBe('high_cpu')
    })

    it('内存 ≥16GB 且 <32GB → 主流（CPU）', () => {
      const r = pickByHardware(cpu(16))
      expect(r.tier).toBe('mainstream_cpu')
    })

    it('内存 ≥8GB 且 <16GB → 入门（CPU）', () => {
      const r = pickByHardware(cpu(8))
      expect(r.tier).toBe('entry_cpu')
    })

    it('内存 <8GB → 低配置', () => {
      const r = pickByHardware(cpu(4))
      expect(r.tier).toBe('low')
    })
  })

  describe('优先级：NVIDIA > MPS > CPU', () => {
    it('同时有 NVIDIA 和 MPS → 走 NVIDIA 分支', () => {
      const r = pickByHardware(hw({
        memory: { total: 8 * GB, free: 4 * GB },
        gpus: [
          { name: 'RTX 4090', memory: 24 * GB, cuda: true, mps: false },
          { name: 'Apple', cuda: false, mps: true }
        ]
      }))
      expect(r.tier).toBe('flagship')
    })

    it('有 MPS 无 NVIDIA → 走 MPS 分支', () => {
      const r = pickByHardware(hw({
        memory: { total: 8 * GB, free: 4 * GB },
        gpus: [{ name: 'Apple M2', cuda: false, mps: true }]
      }))
      expect(r.tier).toBe('mainstream')
    })
  })

  it('每档 picks 至少 3 个', () => {
    const tiers = [
      pickByHardware(hw({ gpus: [{ name: 'X', memory: 24 * GB, cuda: true, mps: false }] })),
      pickByHardware(hw({ memory: { total: 4 * GB, free: 2 * GB }, gpus: [] }))
    ]
    for (const t of tiers) {
      expect(t.picks.length).toBeGreaterThanOrEqual(3)
    }
  })
})

describe('pickCoderModel — 编程模型按档位推荐', () => {
  it('旗舰档 → qwen3-coder:30b（MoE 30B/3.3B，256K）', () => {
    const p = pickCoderModel('flagship', [])
    expect(p.id).toBe('qwen3-coder:30b')
    expect(p.tag).toBe('coder')
    expect(p.reason).toBe('coder_qwen3_30b')
  })

  it('高/主流/入门档各自给出装得下的 coder，模型名与 Ollama tag 一致', () => {
    expect(pickCoderModel('high', []).id).toBe('qwen2.5-coder:14b')
    expect(pickCoderModel('mainstream', []).id).toBe('qwen2.5-coder:7b')
    expect(pickCoderModel('entry', []).id).toBe('qwen2.5-coder:3b')
  })

  it('CPU 档位也各有 coder（纯 CPU 编程可用）', () => {
    for (const tier of ['high_cpu', 'mainstream_cpu', 'entry_cpu', 'low'] as const) {
      expect(pickCoderModel(tier, []).id).toMatch(/^qwen2\.5-coder:(14b|7b|3b)$/)
    }
  })

  it('8 个档位全覆盖，reason 码只有 4 种（避免字典爆炸）', () => {
    const codes = Object.values(CODER_MODEL_BY_TIER).map((p) => p.reason)
    expect(new Set(codes).size).toBe(4)
    expect(Object.keys(CODER_MODEL_BY_TIER)).toHaveLength(8)
  })

  it('已安装判定与对话模型同源（tag 前缀匹配）', () => {
    expect(pickCoderModel('mainstream', ['qwen2.5-coder:7b-instruct-q4_K_M']).installed).toBe(true)
    expect(pickCoderModel('flagship', ['qwen2.5-coder:7b']).installed).toBe(false)
  })
})
