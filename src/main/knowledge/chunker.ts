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
export function findLast(slice: string, token: string, minPos: number): number {
  let idx = slice.lastIndexOf(token)
  while (idx !== -1 && idx < minPos) {
    idx = slice.lastIndexOf(token, idx - 1)
  }
  // 返回 token 结束位置
  return idx === -1 ? -1 : idx + token.length
}

// ---------- Markdown 结构感知分块 ----------

interface MdSection {
  /** 从根到当前节的标题链（含 # 前缀，如 ['# 概述', '## 安装']） */
  headingChain: string[]
  /** 该节正文（不含标题行） */
  content: string
}

/** 按 Markdown 标题层级切分成节；代码块内的 # 不当作标题 */
function splitByHeadings(text: string): MdSection[] {
  const lines = text.split('\n')
  const sections: MdSection[] = []
  let inCodeBlock = false
  let currentChain: string[] = []
  let currentLines: string[] = []

  const flush = () => {
    const content = currentLines.join('\n').trim()
    if (content) {
      sections.push({ headingChain: [...currentChain], content })
    }
    currentLines = []
  }

  for (const line of lines) {
    // 代码块切换（``` 开头）
    if (/^```/.test(line)) {
      inCodeBlock = !inCodeBlock
      currentLines.push(line)
      continue
    }
    if (inCodeBlock) {
      currentLines.push(line)
      continue
    }
    const headingMatch = line.match(/^(#{1,6})\s+\S/)
    if (headingMatch) {
      flush()
      const level = headingMatch[1]!.length
      // 截断链到 level-1 级，再压入当前标题
      currentChain = currentChain.slice(0, level - 1)
      currentChain.push(line)
    } else {
      currentLines.push(line)
    }
  }
  flush()
  return sections
}

/** 构造标题链前缀，超长时从链尾保留最近几级 */
function buildHeadingPrefix(chain: string[], maxLen: number): string {
  if (chain.length === 0) return ''
  let prefix = chain.join(' > ')
  if (prefix.length > maxLen) {
    const kept: string[] = []
    let len = 0
    for (let i = chain.length - 1; i >= 0; i--) {
      const add = chain[i]!.length + (kept.length > 0 ? 3 : 0) // 3 = ' > '
      if (len + add > maxLen && kept.length > 0) break
      kept.unshift(chain[i]!)
      len += add
    }
    prefix = kept.join(' > ')
  }
  return prefix + '\n'
}

/**
 * Markdown 结构感知分块：
 * 1. 按标题层级（# ~ ######）切节，跳过代码块内的 #
 * 2. 每个 chunk 带上标题链前缀（如「# 概述 > ## 安装」），让 embedding 含上下文
 * 3. 节内正文超过预算时，回退到字符级切分（chunkText），每个子 chunk 仍带前缀
 * 对纯文本（无标题）退化为等同 chunkText 的行为。
 */
export function chunkMarkdown(
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

  const sections = splitByHeadings(normalized)
  const chunks: ChunkResult[] = []
  let seq = 0
  const maxPrefixLen = Math.floor(chunkSize * 0.5)

  for (const section of sections) {
    const prefix = buildHeadingPrefix(section.headingChain, maxPrefixLen)
    const prefixLen = prefix.length
    // 正文预算：扣除前缀后至少保留 30%，防止前缀占满
    const budget = Math.max(chunkSize - prefixLen, Math.floor(chunkSize * 0.3))

    if (section.content.length <= budget) {
      const content = (prefix + section.content).trim()
      if (content) chunks.push({ content, sequence: seq++ })
    } else {
      const sub = chunkText(section.content, { chunkSize: budget, chunkOverlap })
      for (const s of sub) {
        const content = (prefix + s.content).trim()
        if (content) chunks.push({ content, sequence: seq++ })
      }
    }
  }

  return chunks
}
