// 智能标题纯函数：兜底标题、标题 prompt、模型返回清洗。
// 不依赖 electron / DB，便于单测；title-gen.ts 负责编排调用。

/** 空文本（纯图片消息等）的兜底标题，与历史会话占位一致 */
export const PLACEHOLDER_TITLE = '新对话'
/** 截断标题与最终标题的最大长度（与历史行为一致） */
export const TITLE_MAX_LEN = 20
/** 模型标题清洗后的字符上限：英文 ≤6 单词可能超过 20 字符，放宽到 40 */
export const MODEL_TITLE_MAX_LEN = 40
/** 送给标题模型的输入上限：只取开头，标题无需全文 */
export const TITLE_INPUT_MAX = 500
/** 标题生成独立超时：超时保留截断标题，不等待慢接口 */
export const TITLE_TIMEOUT_MS = 10_000
/** 短标题输出预算：JSON 包装比纯文本多花约 10-15 token，预留 64 避免被截断 */
export const TITLE_MAX_TOKENS = 64

/** 规则兜底标题：首条消息前 20 字，空内容回退占位标题 */
export function fallbackTitle(userContent: string): string {
  return userContent.slice(0, TITLE_MAX_LEN) || PLACEHOLDER_TITLE
}

/** 构造标题生成 prompt：要求短、同语言、无装饰，输出固定 JSON */
export function buildTitlePrompt(userContent: string): string {
  const input = userContent.slice(0, TITLE_INPUT_MAX)
  return [
    '请为下面这段用户发起的对话起一个简短标题，要求：',
    '1. 用与用户消息相同的语言；',
    '2. 中文不超过 10 个汉字，英文不超过 6 个单词；',
    '3. 概括用户的核心意图，直接输出标题 JSON；',
    '4. 不要把标题包在引号、书名号里，不要在标题末尾加句号；不要「标题：」「关于」之类前缀；',
    '5. 输出格式固定为 {"title":"标题"}，只输出这个 JSON 对象，不要解释、不要 markdown 代码块。',
    '',
    input
  ].join('\n')
}

/**
 * 修复轮 prompt：把上一轮不合规的定位交回模型，只要求重发 JSON 对象。
 * 与原 prompt 一样以用户输入结尾的形态不同——原输入仍在对话历史里，模型可以回看。
 */
export function buildTitleRepairPrompt(problem: string): string {
  return [
    '你上一次的输出不符合要求。',
    `问题：${problem}`,
    '请只输出一个 JSON 对象：{"title":"简短标题"}，不要输出解释、markdown 代码块或其他字段。',
    '标题要求不变：与用户消息同语言；中文不超过 10 个汉字，英文不超过 6 个单词；不要引号、书名号或句末标点。'
  ].join('\n')
}

const WRAPPING_QUOTES = new Set(['"', "'", '“', '”', '‘', '’', '「', '」', '『', '』', '《', '》', '«', '»', '［', '］'])
const TITLE_PREFIXES = /^(标题|title)\s*[:：]\s*/i

/**
 * 清洗模型返回的标题文本；无法得到有效标题时返回 fallback。
 * 去首尾包裹引号、折叠空白换行、去标题前缀与句末标点、超长截断。
 */
export function sanitizeTitle(raw: string, fallback: string): string {
  let s = raw
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  // 成对引号最多剥两层，避免单端引号被误吞
  for (let i = 0; i < 2 && s.length >= 2; i++) {
    if (WRAPPING_QUOTES.has(s[0]!) && WRAPPING_QUOTES.has(s[s.length - 1]!)) {
      s = s.slice(1, -1).trim()
    } else {
      break
    }
  }
  s = s.replace(TITLE_PREFIXES, '').trim()
  s = s.replace(/[。.！!？?…\s]+$/u, '').trim()
  if (!s) return fallback
  return s.slice(0, MODEL_TITLE_MAX_LEN)
}
