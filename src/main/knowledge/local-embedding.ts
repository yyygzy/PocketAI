// 内置本地 embedding 引擎：transformers.js（onnxruntime-node）+ bge-small-zh-v1.5 int8 量化
// 模型随包内置（resources/models，构建时由 scripts/fetch-embedding-model.mjs 下载），
// 强制本地加载不出网，懒加载单例——首次调用时初始化（约 1-2s），进程内复用。
import path from 'node:path'
import { app } from 'electron'
import type { FeatureExtractionPipeline } from '@huggingface/transformers'
import { BUILTIN_EMBED_MODEL, BUILTIN_QUERY_PREFIX } from '../../shared/types'

let extractor: FeatureExtractionPipeline | null = null
let initPromise: Promise<FeatureExtractionPipeline> | null = null

/** 模型目录：打包后 <resources>/models；dev 时项目根 resources/models */
function localModelPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.resolve(process.cwd(), 'resources/models')
}

/** 懒加载单例：失败不缓存，下次调用重试 */
async function getExtractor(): Promise<FeatureExtractionPipeline> {
  if (extractor) return extractor
  if (!initPromise) {
    initPromise = (async () => {
      const { pipeline: createPipeline, env } = await import('@huggingface/transformers')
      // 强制本地模型，禁止任何远端请求（便携离线场景）
      env.allowLocalModels = true
      env.allowRemoteModels = false
      env.localModelPath = localModelPath()
      extractor = (await createPipeline('feature-extraction', BUILTIN_EMBED_MODEL, {
        dtype: 'q8'
      })) as FeatureExtractionPipeline
      return extractor
    })().catch((err) => {
      initPromise = null // 重置以便重试
      throw err
    })
  }
  return initPromise
}

/** 把 pipeline 输出统一展开为每条文本一个向量：
 *  多文本时 transformers.js 返回单个 [batch, dim] Tensor（data 是扁平数组），需按行切片 */
function tensorToVectors(out: unknown): Float32Array[] {
  const tensors = Array.isArray(out) ? out : [out]
  const list: Float32Array[] = []
  for (const t of tensors) {
    const tensor = t as { dims: number[]; data: Float32Array }
    if (Array.isArray(tensor.dims) && tensor.dims.length === 2) {
      const [batch, dim] = tensor.dims
      for (let i = 0; i < batch!; i++) {
        list.push(new Float32Array(tensor.data.slice(i * dim!, (i + 1) * dim!)))
      }
    } else {
      list.push(new Float32Array(tensor.data))
    }
  }
  return list
}

/** 批量向量化（文档侧，不加查询前缀），返回 L2 归一化向量 */
export async function localEmbedTexts(texts: string[]): Promise<Float32Array[]> {
  const ext = await getExtractor()
  const out = await ext(texts, { pooling: 'cls', normalize: true })
  return tensorToVectors(out)
}

/** 单条查询向量化（自动加 bge 检索指令前缀） */
export async function localEmbedQuery(query: string): Promise<Float32Array> {
  const ext = await getExtractor()
  const out = await ext(
    query.startsWith(BUILTIN_QUERY_PREFIX) ? query : `${BUILTIN_QUERY_PREFIX}${query}`,
    { pooling: 'cls', normalize: true }
  )
  const [vec] = tensorToVectors(out)
  if (!vec) throw new Error('本地 embedding 返回空结果')
  return vec
}

/** 释放模型（低内存场景/测试用；再次调用会重新初始化） */
export function disposeLocalEmbedding(): void {
  extractor?.dispose?.()
  extractor = null
  initPromise = null
}
