// 技能内容解析器：JSON + Markdown（带 YAML frontmatter）→ 统一 SkillShape
//
// 设计：
//  - 不引 gray-matter / js-yaml，手写轻量解析（只支持标量字段 string/number/boolean）
//  - 两种输入都输出 SkillShape { name, description?, icon?, content }
//  - 严格 schema 校验：只接受白名单字段，拒绝任意注入
//  - content 上限 8KB，防超长提示词灌爆 prompt
import type { BuiltinSkill } from '../db/repositories/skill.repo'

/** 解析后的统一技能形状（skillRepo.save 接受的子集） */
export interface SkillShape {
  name: string
  description: string
  icon: string
  content: string
  /** 可选元数据（SDK v1 扩展，不影响执行，仅用于展示/分类） */
  version?: string
  author?: string
  tags?: string[]
  category?: string
}

const MAX_CONTENT_BYTES = 8 * 1024

/** 合法 frontmatter key（白名单，拒绝任意字段注入） */
const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'icon', 'title', 'version', 'author', 'tags', 'category'])

/** 标量 YAML 值解析（只处理 string / number / boolean，不支持嵌套） */
function parseScalar(raw: string): string | number | boolean {
  const s = raw.trim()
  if (s === '' || s === '~' || s.toLowerCase() === 'null') return ''
  if (s === 'true') return true
  if (s === 'false') return false
  // 数字（整数/浮点，不含科学计数法防注入）
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  // 带引号字符串：去引号 + 转义
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n')
  }
  return s
}

/** 从 Markdown 文本提取 YAML frontmatter（--- 之间的块）+ 正文 */
function splitFrontmatter(md: string): { frontmatter: string | null; body: string } {
  const trimmed = md.trimStart()
  if (!trimmed.startsWith('---')) return { frontmatter: null, body: md.trim() }
  // 找到第二个 --- 分隔符
  const afterFirst = trimmed.slice(3)
  const endIdx = afterFirst.search(/\n\s*---\s*\n/)
  if (endIdx === -1) return { frontmatter: null, body: md.trim() }
  const frontmatter = afterFirst.slice(0, endIdx)
  const body = afterFirst.slice(endIdx).replace(/^\n\s*---\s*\n/, '').trim()
  return { frontmatter, body }
}

/** 解析 YAML frontmatter 为 Record（仅标量，且 key 必须在白名单内） */
function parseFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith('#')) continue
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const key = line.slice(0, colonIdx).trim()
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) continue
    const val = parseScalar(line.slice(colonIdx + 1))
    if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
      out[key] = String(val).trim()
    }
  }
  return out
}

/** 校验 SkillShape，返回错误信息（空串=合法） */
function validate(shape: SkillShape): string {
  if (!shape.name || !shape.name.trim()) return '缺少 name 字段'
  if (shape.name.length > 80) return 'name 过长（上限 80 字符）'
  if (!shape.content || !shape.content.trim()) return '缺少 content 字段'
  if (Buffer.byteLength(shape.content, 'utf8') > MAX_CONTENT_BYTES) {
    return `content 过长（上限 ${MAX_CONTENT_BYTES / 1024}KB）`
  }
  if (shape.icon && shape.icon.length > 4) return 'icon 过长（上限 4 字符）'
  return ''
}

/** 从 JSON 字符串解析 */
export function parseSkillJson(text: string): { shape: SkillShape | null; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { shape: null, error: 'JSON 解析失败' }
  }
  if (!parsed || typeof parsed !== 'object') return { shape: null, error: '不是合法对象' }

  // 支持两种格式：
  // A) PocketAI 标准：{ format:'pocketai-skill', skill:{ name, description, icon, content } }
  // B) 扁平格式：{ name, description, icon, content }
  const obj = parsed as Record<string, unknown>
  let raw: Record<string, unknown> = obj
  if (obj.format === 'pocketai-skill' && obj.skill && typeof obj.skill === 'object') {
    raw = obj.skill as Record<string, unknown>
  }

  const shape: SkillShape = {
    name: typeof raw.name === 'string' ? raw.name.trim() : '',
    description: typeof raw.description === 'string' ? raw.description.trim() : '',
    icon: typeof raw.icon === 'string' && raw.icon.trim() ? raw.icon.trim().slice(0, 4) : '⚡',
    content: typeof raw.content === 'string' ? raw.content.trim() : '',
    version: typeof raw.version === 'string' ? raw.version.trim() : undefined,
    author: typeof raw.author === 'string' ? raw.author.trim() : undefined,
    category: typeof raw.category === 'string' ? raw.category.trim() : undefined,
    tags: Array.isArray(raw.tags)
      ? raw.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).slice(0, 10)
      : undefined
  }
  const err = validate(shape)
  if (err) return { shape: null, error: err }
  return { shape, error: '' }
}

/** 从 Markdown 字符串解析（可选 YAML frontmatter + 正文 = content） */
export function parseSkillMarkdown(text: string): { shape: SkillShape | null; error: string } {
  const { frontmatter, body } = splitFrontmatter(text)
  let fm: Record<string, string> = {}
  if (frontmatter) {
    fm = parseFrontmatter(frontmatter)
  }

  // frontmatter 里 title 兼容 name
  const name = (fm.name || fm.title || '').trim()
  const description = (fm.description || '').trim()
  const icon = (fm.icon || '⚡').trim().slice(0, 4)
  const content = body
  const version = (fm.version || '').trim() || undefined
  const author = (fm.author || '').trim() || undefined
  const category = (fm.category || '').trim() || undefined
  // tags 支持逗号分隔：tag1, tag2, tag3
  const tags = fm.tags
    ? fm.tags.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 10)
    : undefined

  const shape: SkillShape = { name, description, icon, content, version, author, tags, category }
  const err = validate(shape)
  if (err) return { shape: null, error: err }
  return { shape, error: '' }
}

/** 自动检测格式（JSON vs Markdown）并解析 */
export function parseSkillText(text: string): { shape: SkillShape | null; error: string } {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return parseSkillJson(text)
  }
  return parseSkillMarkdown(text)
}

/** 转成 BuiltinSkill（供 skillRepo.upsertBuiltin 使用） */
export function toBuiltinSkill(id: string, shape: SkillShape): BuiltinSkill {
  return {
    id,
    name: shape.name,
    description: shape.description,
    icon: shape.icon,
    content: shape.content
  }
}

/** Registry index 条目 */
export interface RegistrySkill {
  id: string
  name: string
  description?: string
  icon?: string
  /** 远程 JSON 或 Markdown 的 URL */
  url: string
  /** md5/sha256 可选，暂不强制 */
  hash?: string
}

/** 解析远程 registry index */
export function parseRegistryIndex(text: string): { skills: RegistrySkill[]; error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { skills: [], error: 'Index JSON 解析失败' }
  }
  if (!parsed || typeof parsed !== 'object') return { skills: [], error: 'Index 不是合法对象' }
  const arr = (parsed as { skills?: unknown; data?: unknown }).skills
    ?? (parsed as { skills?: unknown; data?: unknown }).data
    ?? parsed
  if (!Array.isArray(arr)) return { skills: [], error: 'Index 缺少 skills 数组' }

  const out: RegistrySkill[] = []
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const id = typeof r.id === 'string' ? r.id.trim() : ''
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const url = typeof r.url === 'string' ? r.url.trim() : ''
    if (!id || !name || !url) continue // 跳过不完整条目
    out.push({
      id,
      name,
      description: typeof r.description === 'string' ? r.description.trim() : undefined,
      icon: typeof r.icon === 'string' ? r.icon.trim().slice(0, 4) : undefined,
      url,
      hash: typeof r.hash === 'string' ? r.hash.trim() : undefined
    })
  }
  return { skills: out, error: '' }
}

// ─── SDK：技能校验与模板 ─────────────────────────────────────────

/** 校验结果 */
export interface SkillValidationResult {
  ok: boolean
  error?: string
  warnings: string[]
  shape?: SkillShape
}

/** 校验技能文本，返回详细结果（含警告，如缺少 description 等） */
export function validateSkillText(text: string): SkillValidationResult {
  const warnings: string[] = []
  const { shape, error } = parseSkillText(text)
  if (!shape || error) {
    return { ok: false, error, warnings }
  }
  if (!shape.description) warnings.push('缺少 description，建议补充技能用途说明')
  if (shape.content.length < 20) warnings.push('content 过短，可能无法有效引导模型')
  if (shape.icon === '⚡') warnings.push('未设置 icon，使用默认 ⚡')
  return { ok: true, warnings, shape }
}

/** 内置技能模板（供"从模板创建"使用） */
export const SKILL_TEMPLATES: { id: string; name: string; description: string; shape: SkillShape }[] = [
  {
    id: 'general-assistant',
    name: '通用助手模板',
    description: '适用于日常问答、写作、分析的通用技能',
    shape: {
      name: '我的通用助手',
      description: '一个友好、专业的通用助手',
      icon: '🤖',
      content: '你是一个友好、专业的助手。请用清晰、简洁的语言回答用户问题，必要时分点说明。遇到不确定的内容，坦诚告知用户。',
      version: '1.0.0',
      category: '通用'
    }
  },
  {
    id: 'code-assistant',
    name: '代码助手模板',
    description: '适用于代码生成、审查、调试的技能',
    shape: {
      name: '代码审查助手',
      description: '专注于代码质量与最佳实践的审查助手',
      icon: '💻',
      content: '你是一个资深代码审查助手。审查代码时关注：1) 正确性与边界条件 2) 可读性与命名 3) 性能与资源泄漏 4) 安全隐患。给出具体改进建议，附代码示例。',
      version: '1.0.0',
      category: '开发',
      tags: ['code', 'review']
    }
  },
  {
    id: 'translation',
    name: '翻译助手模板',
    description: '适用于多语言翻译与本地化的技能',
    shape: {
      name: '专业翻译',
      description: '忠实原文、符合目标语言习惯的翻译助手',
      icon: '🌐',
      content: '你是一个专业翻译。翻译时：1) 忠实原文含义 2) 符合目标语言表达习惯 3) 保留专业术语 4) 不添加原文没有的内容。如遇歧义，在译文后用括号标注原文。',
      version: '1.0.0',
      category: '语言',
      tags: ['translation']
    }
  }
]
