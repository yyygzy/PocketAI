// Ollama 本地 API 载荷解析（V4-Iter-140）
//
// fixture 取自本机 Ollama 0.33.1 的真实响应形状（V-0 探针原样抄回），不是手搓的理想形状。
// 存在的理由：ollama-runtime.ts 依赖 electron/portable，测试里整模块常被桩掉 ⇒ 解析放那儿测不到。
import { describe, it, expect } from 'vitest'
import { parseOllamaPs, parseOllamaTags } from '../src/shared/ollama-models'

const TAGS_FIXTURE = {
  models: [
    {
      name: 'qwen2.5:3b-instruct',
      model: 'qwen2.5:3b-instruct',
      size: 1929912432,
      digest: 'sha256:359f1e2c71b3b0522442bc7287f808de6f211f8ead228ebf247dbeec9f91394b',
      modified_at: '2026-10-01T09:12:33.9189014+08:00',
      details: { parent_model: '', family: 'qwen', families: ['qwen'], parameter_size: '3.1B', quantization_level: 'Q4_K_M' }
    },
    {
      name: 'bge-m3:latest',
      model: 'bge-m3:latest',
      size: 1157672605,
      digest: 'sha256:7ca91e0fa9913e4c10ed742ec57c83228b7c2414d5b3d23c133a1d59a34caffc',
      details: { family: 'bert', parameter_size: '566.70M', quantization_level: 'F16' }
    }
  ]
}

describe('parseOllamaTags —— 体积与量化必须留住（原先只读 name，拿到就丢）', () => {
  it('真实形状：name / sizeBytes / digest / parameterSize / quantization 全保留且按序', () => {
    const rows = parseOllamaTags(TAGS_FIXTURE)
    expect(rows.map((r) => r.name)).toEqual(['qwen2.5:3b-instruct', 'bge-m3:latest'])
    expect(rows[0]).toMatchObject({
      sizeBytes: 1929912432,
      parameterSize: '3.1B',
      quantizationLevel: 'Q4_K_M'
    })
    expect(rows[0]!.digest).toMatch(/^sha256:/)
    expect(rows[1]!.quantizationLevel).toBe('F16')
  })

  it('名字保持原样（不带 tag 的 base 名由调用方自己比，digest 才是失效键）', () => {
    expect(parseOllamaTags(TAGS_FIXTURE)[1]!.name).toBe('bge-m3:latest')
  })

  it('缺 details / 缺 size / 缺 digest ⇒ 落成空值而不是猜', () => {
    const rows = parseOllamaTags({ models: [{ name: 'x:latest' }] })
    expect(rows).toEqual([
      { name: 'x:latest', sizeBytes: 0, digest: '', parameterSize: '', quantizationLevel: '' }
    ])
  })

  it('size 是字符串也不偷偷 Number() —— 0 表示"未告知"', () => {
    expect(parseOllamaTags({ models: [{ name: 'x', size: '1929912432' }] })[0]!.sizeBytes).toBe(0)
  })

  it('负数 / NaN / null 体积都当未告知', () => {
    for (const size of [-5, Number.NaN, null, undefined]) {
      expect(parseOllamaTags({ models: [{ name: 'x', size }] })[0]!.sizeBytes).toBe(0)
    }
  })

  it('无 name 的条目跳过；脏载荷当空表，不抛', () => {
    expect(parseOllamaTags({ models: [{ size: 1 }, { name: '' }, { name: 'ok', size: 10 }] })).toHaveLength(1)
    for (const raw of [null, undefined, {}, { models: null }, { models: 'x' }, []]) {
      expect(parseOllamaTags(raw)).toEqual([])
    }
  })
})

describe('parseOllamaPs —— 驻留是账面记账，解析不许被当成显存真相', () => {
  const PS_FIXTURE = {
    models: [
      {
        name: 'qwen2.5:3b-instruct',
        model: 'qwen2.5:3b-instruct',
        size: 2159374499,
        size_vram: 2159374499,
        expires_at: '2026-10-15T09:34:47.9147658+08:00'
      },
      { name: 'bge-m3:latest', size_vram: 664000265, expires_at: '2026-10-15T10:09:44.1147362+08:00' }
    ]
  }

  it('保留 size_vram 与 expires_at；空 /api/ps 给空表', () => {
    const rows = parseOllamaPs(PS_FIXTURE)
    expect(rows).toHaveLength(2)
    expect(rows[0]!.sizeVramBytes).toBe(2159374499)
    expect(rows[1]!.name).toBe('bge-m3:latest')
    expect(rows[1]!.expiresAt).toMatch(/^2026-10-15T/)
    expect(parseOllamaPs({ models: [] })).toEqual([])
    expect(parseOllamaPs(null)).toEqual([])
  })

  it('缺 size_vram ⇒ 0；缺 expires_at ⇒ 空串（都是"未告知"，不是"不占/永久驻留"）', () => {
    const rows = parseOllamaPs({ models: [{ name: 'x' }] })
    expect(rows).toEqual([{ name: 'x', sizeVramBytes: 0, expiresAt: '' }])
  })
})
