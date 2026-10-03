// 全局命令面板：数据类型与过滤纯函数（CommandPalette UI 与单测共用）
// 匹配规则刻意只做大小写不敏感子串（title + subtitle），不做拼音/模糊评分——
// 数据量为本地会话/助手/知识库（百级内），子串足够快且小白可预测。

export type PaletteType = 'conv-chat' | 'conv-agent' | 'assistant' | 'kb' | 'module'

export interface PaletteItem {
  /** 同 type 内唯一（会话 id / 助手 id / kb id / 模块 id） */
  id: string
  type: PaletteType
  title: string
  /** 副标题：会话预览、助手名、库描述等（参与匹配） */
  subtitle?: string
  /** 会话项携带：会话归属助手 id（打开时可能需先切助手） */
  assistantId?: string
  /** 模块项的模块 id（type==='module'） */
  moduleId?: string
}

/** 过滤结果上限（防超长列表渲染卡顿） */
export const PALETTE_LIMIT = 50

/** 单项是否命中查询：大小写不敏感子串匹配 title + subtitle（q 内部转小写，调用方无需预处理） */
export function matchesQuery(item: PaletteItem, q: string): boolean {
  if (!q) return true
  const hay = `${item.title}\n${item.subtitle ?? ''}`.toLowerCase()
  return hay.includes(q.toLowerCase())
}

/**
 * 过滤面板条目：
 * - query 为空/空白：保留输入顺序截断到 PALETTE_LIMIT
 * - 否则按子串匹配，保持输入顺序（稳定，调用方按分组权重排好序）
 */
export function filterPaletteItems(items: PaletteItem[], query: string, limit: number = PALETTE_LIMIT): PaletteItem[] {
  const q = query.trim().toLowerCase()
  const out: PaletteItem[] = []
  for (const item of items) {
    if (matchesQuery(item, q)) {
      out.push(item)
      if (out.length >= limit) break
    }
  }
  return out
}

/**
 * 键盘导航：在可选条目数组中计算下一个选中下标（循环）。
 * 分组标题不进该数组，故无需跳过逻辑。
 * @param cur 当前下标（空列表传 -1）
 * @param len 可选条目数
 * @param dir 1=下一个，-1=上一个
 */
export function nextPaletteIndex(cur: number, len: number, dir: 1 | -1): number {
  if (len <= 0) return -1
  if (cur < 0) return dir === 1 ? 0 : len - 1
  return (cur + dir + len) % len
}
