// 数据健康「向量索引」卡片的文案（抽出来供用例钉住混合维度这一关键情形）
import type { DataHealthReport } from '../../../shared/types'

type TFn = (key: string, vars?: Record<string, string | number>) => string

export function formatVectorIndex(vi: DataHealthReport['kb']['vectorIndex'], t: TFn): string {
  if (!vi || vi.count <= 0) return t('dh.vectorIndexNone')
  // 维度并列出现说明库里混过两套 embedding 模型的向量：语义检索必漏一部分，
  // 卡片要能一眼看出来，而不是只报一个总数（配套的坏文档见「知识库完整性」区块）
  return t('dh.vectorIndexValue', { n: vi.count.toLocaleString('en-US'), dims: vi.dims.join('/') || '?' })
}
