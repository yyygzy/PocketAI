// RetrievedChunk → MessageSource：引用溯源落库/上报用的映射（纯函数，零依赖）
//
// 为什么单独一个模块、而不是在各调用点各写一遍 map：
// 聊天（chat-service）、Agent 首轮 {{knowledge}} 注入（agent/engine）、KB 问答（ask-service）
// 三条路都要把检索结果变成消息来源。此前三处内联写了两份，Agent 那份漏了 kbId/seq，
// 于是 Agent 的回答「有来源、点不动」（跳转条件就是这两个字段，见 V4-Iter-123）。
// 放在 shared/ 而非 knowledge/rag.ts 里：调用方测试普遍把 rag 整模块打桩，
// 把一个纯映射寄居在被桩掉的模块里，会退化成「桩没给就是 undefined」。
import type { MessageSource, RetrievedChunk } from './types'

export function chunksToSources(chunks: RetrievedChunk[]): MessageSource[] {
  return chunks.map((c) => ({
    chunkId: c.chunkId,
    docId: c.docId,
    docTitle: c.docTitle,
    content: c.content,
    kbId: c.kbId,
    seq: c.seq
  }))
}
