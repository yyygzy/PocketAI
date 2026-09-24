// kb_search 内置工具：在当前助手绑定的知识库中做 向量 + BM25 混合检索（复用 ragService）。
// 与 SystemPrompt 的 {{knowledge}} 自动注入互补：自动注入只带「用户原话」的首轮片段，
// kb_search 让 LLM 在多步推理中按需主动检索（换关键词、逐步细化、查证细节）。
// 设计要点：kbIds 由引擎按次运行经 ToolExecuteContext 透传，不用模块级全局状态，
// 避免多窗口并发 Agent 运行时互相串知识库。未绑定知识库时返回提示（不抛错，防重试循环）。
import type { BuiltinTool, ToolExecuteContext } from './builtin'
import { ragService } from '../knowledge/rag'

const DEFAULT_TOP_K = 4
const MAX_TOP_K = 8
// 每片段截断：topK=4 时总结果约 1.6K 字符，低于引擎 2000 字符硬截断兜底
const MAX_CHUNK_CHARS = 350

/** 摘要截断 + 空白折叠（与 websearch.ts 的 cut 同策略） */
function cut(text: unknown, max: number): string {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

export const kbSearchTool: BuiltinTool = {
  schema: {
    id: 'kb.search',
    name: 'kb_search',
    description:
      '在当前助手绑定的知识库中检索资料（语义向量 + 关键词混合检索），返回最相关的文档片段。回答资料类问题前可主动调用查证。参数：query (string)，top_k (number, 可选, 默认 4, 最多 8)。未绑定知识库时返回提示。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题或关键词' },
        top_k: { type: 'number', description: '返回片段数，默认 4，最多 8' }
      },
      required: ['query'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto',
    timeoutMs: 15_000 // 查询向量化可能走远程 embedding API
  },
  async execute(args, ctx?: ToolExecuteContext) {
    const query = String(args?.query ?? '').trim()
    if (!query) throw new Error('query 不能为空')

    const kbIds = ctx?.kbIds ?? []
    if (kbIds.length === 0) {
      return JSON.stringify({
        query,
        results: [],
        note: '当前助手未绑定知识库，无法检索。请先在助手设置中绑定知识库。'
      })
    }

    const topKRaw = Number(args?.top_k)
    const topK =
      Number.isFinite(topKRaw) && topKRaw > 0
        ? Math.min(Math.floor(topKRaw), MAX_TOP_K)
        : DEFAULT_TOP_K

    const { chunks } = await ragService.retrieve(kbIds, query, { topN: topK })
    if (chunks.length === 0) {
      return JSON.stringify({ query, results: [], note: '知识库中未检索到相关内容' })
    }

    const results = chunks.map((c) => ({
      docTitle: c.docTitle,
      docId: c.docId,
      chunkId: c.chunkId,
      content: cut(c.content, MAX_CHUNK_CHARS),
      score: Math.round(c.score * 10000) / 10000
    }))
    return JSON.stringify({ query, results })
  }
}
