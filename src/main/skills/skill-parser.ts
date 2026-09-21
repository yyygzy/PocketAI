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
}

const MAX_CONTENT_BYTES = 8 * 1024

/** 合法 frontmatter key（白名单，拒绝任意字段注入） */
const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'icon', 'title'])

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
    content: typeof raw.content === 'string' ? raw.content.trim() : ''
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

  const shape: SkillShape = { name, description, icon, content }
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
