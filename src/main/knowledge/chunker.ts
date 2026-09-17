// 文本分块：按字符大小 + 重叠切分，尽量在段落/句子边界断开
// v1 用字符估算（中文 1 字≈1 token，英文 4 字符≈1 token，综合够用）
// 后续可换 tiktoken 精确分词
export interface ChunkResult {
  content: string
  sequence: number
}

export function chunkText(
  text: string,
  opts: { chunkSize: number; chunkOverlap: number }
): ChunkResult[] {
  const { chunkSize, chunkOverlap } = opts
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  if (!normalized) return []
  if (normalized.length <= chunkSize) {
    return [{ content: normalized, sequence: 0 }]
  }

  const chunks: ChunkResult[] = []
  let pos = 0
  let seq = 0
  const half = Math.floor(chunkSize * 0.5)

  while (pos < normalized.length) {
    const end = pos + chunkSize
    if (end >= normalized.length) {
      const tail = normalized.slice(pos).trim()
      if (tail) chunks.push({ content: tail, sequence: seq++ })
      break
    }

    const slice = normalized.slice(pos, end)
    // 优先在段落边界断开，其次句子，再次换行/空格
    let breakAt = findLast(slice, '\n\n', half)
    if (breakAt < 0) breakAt = findLast(slice, '。', half)
    if (breakAt < 0) breakAt = findLast(slice, '. ', half)
    if (breakAt < 0) breakAt = findLast(slice, '\n', half)
    if (breakAt < 0) breakAt = findLast(slice, ' ', half)
    if (breakAt < 0) breakAt = slice.length

    const content = slice.slice(0, breakAt).trim()
    if (content) chunks.push({ content, sequence: seq++ })

    // 带重叠推进
    const advance = Math.max(breakAt - chunkOverlap, 1)
    pos += advance
  }

  return chunks
}

/** 从 slice 中找目标子串的最后一个出现位置，要求至少在 minPos 之后 */
function findLast(slice: string, token: string, minPos: number): number {
  let idx = slice.lastIndexOf(token)
  while (idx !== -1 && idx < minPos) {
    idx = slice.lastIndexOf(token, idx - 1)
  }
  // 返回 token 结束位置
  return idx === -1 ? -1 : idx + token.length
}
