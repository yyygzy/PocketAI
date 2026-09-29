// 内置本地 embedding 真实推理冒烟测试：加载 resources/models 下的 bge-small-zh-v1.5 int8
// 验证：512 维输出、L2 归一化、批内语义区分（相似句相似度 > 无关句）
// 注意：真实推理，首次加载约 1-3s，独立文件避免与其他 mock 冲突
import { describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

vi.mock('electron', () => ({ app: { isPackaged: false } }))

const MODEL_DIR = path.resolve(process.cwd(), 'resources/models/Xenova/bge-small-zh-v1.5')
const modelAvailable = fs.existsSync(path.join(MODEL_DIR, 'onnx/model_quantized.onnx'))

describe.skipIf(!modelAvailable)('localEmbedding 真实推理', () => {
  it('文档侧：512 维 + L2 归一化', async () => {
    const { localEmbedTexts } = await import('../src/main/knowledge/local-embedding')
    const vec = (await localEmbedTexts(['今天天气很好，适合出去散步']))[0]!
    expect(vec).toHaveLength(512)
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0))
    expect(norm).toBeCloseTo(1, 5)
  })

  it('查询侧：加前缀后维度一致，且前缀幂等（同一查询两次调用结果一致）', async () => {
    const { localEmbedQuery } = await import('../src/main/knowledge/local-embedding')
    const q = '如何备份知识库'
    const [v1, v2] = await Promise.all([localEmbedQuery(q), localEmbedQuery(q)])
    expect(v1).toHaveLength(512)
    expect(Array.from(v1)).toEqual(Array.from(v2))
  })

  it('语义区分：相关句相似度高于无关句', async () => {
    const { localEmbedTexts } = await import('../src/main/knowledge/local-embedding')
    const [q, hit, miss] = (await localEmbedTexts([
      '如何备份知识库数据',
      '知识库可以通过 WebDAV 定时备份到云端',
      '红烧肉的做法需要五花肉和生抽'
    ])) as [Float32Array, Float32Array, Float32Array]
    const dot = (a: Float32Array, b: Float32Array) =>
      a.reduce((s, v, i) => s + v * (b as Float32Array)[i]!, 0)
    const rel = dot(q, hit)
    const irr = dot(q, miss)
    expect(rel).toBeGreaterThan(irr)
  })
})
