// 技能装前静态扫描（只读文本，不做安全判定）
//
// 边界写在这里，调用方与界面都别越：
//  · 输入只有：技能正文、随包资源**清单**（路径/大小，不读文件内容）、被忽略的声明字段；
//  · 输出只有「候选与事实」——正文里出现了哪些已知形状的措辞、清单里有哪些类型的文件；
//  · 不回答「这个技能安全吗」，也不替代运行时（模型会不会真的调工具、调了什么、外发了什么，
//    只有真实运行才知道）。所以分级用 none/info/notice/attention，不用 safe/unsafe。

// 结果形状与渲染层共用，放在 shared；这里转出，保持主进程内原有 import 路径可用
import type {
  SkillFinding,
  SkillFindingLevel,
  SkillFindingWhere,
  SkillScanInput,
  SkillScanLevel,
  SkillScanResource,
  SkillScanResult
} from '../../shared/skill-scan'

export type {
  SkillFinding,
  SkillFindingLevel,
  SkillFindingWhere,
  SkillScanInput,
  SkillScanLevel,
  SkillScanResource,
  SkillScanResult
} from '../../shared/skill-scan'

const MAX_SCAN_CHARS = 64 * 1024
const MAX_FINDINGS = 50
const MAX_EXAMPLES = 5
const MAX_EXAMPLE_CHARS = 120

const LEVEL_RANK: Record<SkillScanLevel, number> = {
  none: 0,
  info: 1,
  notice: 2,
  attention: 3
}

/** 命中片段统一压成一行，避免把整段正文带进审计 */
function clip(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > MAX_EXAMPLE_CHARS ? `${oneLine.slice(0, MAX_EXAMPLE_CHARS)}…` : oneLine
}

/** URL 只留 origin + pathname：查询串/锚点里可能带令牌，审计不该抄进去 */
export function safeUrlForDisplay(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}`
  } catch {
    return raw.split(/[?#]/)[0] ?? raw
  }
}

function matchArrays(pattern: RegExp, text: string): RegExpMatchArray[] {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  return Array.from(text.matchAll(new RegExp(pattern.source, flags)))
}

function allMatches(pattern: RegExp, text: string): Array<{ index: number; text: string }> {
  return matchArrays(pattern, text).map((m) => ({ index: m.index ?? 0, text: m[0] }))
}

/** 「不要忽略规则」这类否定句不算候选；只在覆盖/忽略类规则上过滤 */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 12), index)
  return /(?:do not|don't|never|not)\s*$/i.test(before) || /(?:不要|请勿|不能|不得|禁止|切勿)$/.test(before)
}

interface ContentRule {
  code: string
  level: Exclude<SkillFindingLevel, 'info'>
  detail: string
  patterns: RegExp[]
  /** 命中前文是否定词时跳过（避免「不要忽略规则」这类反例） */
  skipIfNegated?: boolean
}

const CONTENT_RULES: ContentRule[] = [
  {
    code: 'PROMPT_OVERRIDE_PHRASE',
    level: 'notice',
    detail: '正文出现要求覆盖或忽略既有指令的措辞（候选，需人工确认）',
    skipIfNegated: true,
    patterns: [
      /ignore\s+(?:all\s+|any\s+)?(?:the\s+)?(?:previous|prior|above|earlier|system)\s+(?:instructions?|prompts?|rules?|directives?)/i,
      /disregard\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|system)\s+(?:instructions?|prompts?|rules?)/i,
      /(?:忽略|无视|遗忘|忘记|抛弃|不要遵守|不用遵守|无需遵守)[^。！？\n]{0,20}?(?:指令|指示|提示词?|规则|设定|约束|限制)/,
      /(?:覆盖|改写|替换)(?:系统)?(?:提示词|指令|规则)/,
      /\b(?:jailbreak|DAN\s+mode|developer\s+mode)\b/i,
      /(?:绕过|跳过|规避|解除|关闭)[^。！？\n]{0,12}(?:安全|审查|限制|过滤|防护|审批)/
    ]
  },
  {
    code: 'CREDENTIAL_ACCESS_PHRASE',
    level: 'attention',
    detail: '正文提到密钥或凭证类内容（候选，需人工确认）',
    patterns: [
      /(?:\.ssh\b|id_rsa\b|id_ed25519\b|\.aws\b|\.npmrc\b|\.git-credentials\b|\.netrc\b|credentials?\.json\b|keychain\b|\.env\b)/i,
      /(?:api[_-]?key|access[_-]?token|secret[_-]?key|client[_-]?secret|private[_-]?key|session[_-]?cookie)/i,
      /(?:密码|口令|密钥|私钥|凭证|凭据|令牌|钱包|助记词|种子短语)/
    ]
  },
  {
    code: 'PIPE_EXECUTION',
    level: 'attention',
    detail: '正文出现下载后管道执行的写法（候选，需人工确认）',
    patterns: [
      /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|ksh|python3?|node|perl|ruby|powershell|pwsh|cmd)\b/i,
      /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]{0,200}\|\s*(?:iex|invoke-expression)\b/i,
      /\b(?:bash|sh|zsh|powershell|pwsh|cmd(?:\.exe)?)\s+-(?:c|e|enc|encodedcommand)\b/i,
      /\bInvoke-Expression\b/i
    ]
  },
  {
    code: 'RECURSIVE_DELETE',
    level: 'attention',
    detail: '正文出现递归删除或格式化类命令（候选，需人工确认）',
    patterns: [
      /\brm\s+(?:-[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\b/i,
      /\brm\s+(?:-r|--recursive)\b[^\n]{0,40}(?:-f|--force)\b/i,
      /\b(?:del|erase)\s+\/[sq]\b/i,
      /\b(?:rd|rmdir)\s+\/s\b/i,
      /\bRemove-Item\b[^\n]{0,120}(?:-Recurse|-Force)/i,
      /\b(?:format|mkfs(?:\.\w+)?)\s+[a-z]:/i,
      /\bgit\s+clean\s+-[a-z]*[fdx]/i,
      /(?:递归删除|删除整个目录|清空整个目录)/
    ]
  },
  {
    code: 'EXTERNAL_EGRESS',
    level: 'notice',
    detail: '正文出现向外部地址发送数据的写法（候选，需人工确认）',
    patterns: [
      /\bcurl\b[^\n]{0,200}(?:-X\s*POST|--data|-d\s|--upload-file|-T\s|--form|-F\s)/i,
      /\bwget\b[^\n]{0,200}--post-(?:data|file)/i,
      /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^\n]{0,200}-(?:Method\s+Post|Body|Uri)/i,
      /\b(?:fetch|axios\.(?:post|put)|requests\.(?:post|put)|http\.request)\s*\(/i,
      /\b(?:webhook|pastebin|transfer\.sh|ngrok|requestbin|pipedream)\b/i,
      /(?:上传|发送|外发|回传|上报)[^。！？\n]{0,40}https?:\/\//i,
      /https?:\/\/[^\s<>"'`)\]]{0,200}[^。！？\n]{0,40}(?:上传|发送|外发|回传|上报)/i
    ]
  }
]

const URL_PATTERN = /https?:\/\/[^\s<>"'`)\]}]+/gi
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:[\\/][^\s<>"|?*]*/g
const UNC_PATH_PATTERN = /\\\\[A-Za-z0-9._-]+\\[^\s<>"|?*]*/g
const UNIX_PATH_PATTERN = /(?:^|[\s"'`(=])((?:\/(?:etc|usr|var|home|root|opt|tmp|bin|sbin|dev|proc|Users|Library|System|Applications|private)\/)[^\s"'`),;]*)/g
const ENV_PATH_PATTERN = /%(?:USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP)%[\\/][^\s<>"|?]*/gi
const HOME_PATH_PATTERN = /(?:~\/|\$HOME\/)[^\s"'`),;]+/g

const SCRIPT_EXTENSIONS = new Set([
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd', 'py', 'rb', 'pl', 'php',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'lua', 'vbs', 'vbe', 'hta', 'applescript', 'scpt', 'awk', 'sed'
])
const BINARY_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin', 'node', 'wasm', 'msi', 'scr', 'com', 'apk',
  'dmg', 'pkg', 'jar', 'class', 'pyc', 'o', 'a'
])

function uniqExamples(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const v = clip(raw)
    if (!v || seen.has(v)) continue
    seen.add(v)
    out.push(v)
    if (out.length >= MAX_EXAMPLES) break
  }
  return out
}

function finding(
  code: string,
  level: SkillFindingLevel,
  where: SkillFindingWhere,
  detail: string,
  matches: string[]
): SkillFinding | null {
  const examples = uniqExamples(matches)
  if (examples.length === 0) return null
  return { code, level, where, detail, count: matches.length, examples }
}

function scanContentRules(text: string): SkillFinding[] {
  const out: SkillFinding[] = []
  for (const rule of CONTENT_RULES) {
    const hits: string[] = []
    for (const pattern of rule.patterns) {
      for (const m of allMatches(pattern, text)) {
        if (rule.skipIfNegated && isNegated(text, m.index)) continue
        hits.push(m.text)
      }
    }
    const f = finding(rule.code, rule.level, 'content', rule.detail, hits)
    if (f) out.push(f)
  }
  return out
}

function scanUrls(text: string): SkillFinding[] {
  const raw = allMatches(URL_PATTERN, text).map((m) => m.text.replace(/[.,;:!?]+$/, ''))
  const safe = raw.map(safeUrlForDisplay)
  const f = finding(
    'URL_REFERENCE',
    'info',
    'content',
    '正文含外部 URL（仅事实，未访问）',
    safe
  )
  return f ? [f] : []
}

function scanAbsolutePaths(text: string): SkillFinding[] {
  const hits: string[] = []
  for (const m of allMatches(WINDOWS_PATH_PATTERN, text)) hits.push(m.text)
  for (const m of allMatches(UNC_PATH_PATTERN, text)) hits.push(m.text)
  for (const m of matchArrays(UNIX_PATH_PATTERN, text)) hits.push(m[1] ?? m[0])
  for (const m of allMatches(ENV_PATH_PATTERN, text)) hits.push(m.text)
  for (const m of allMatches(HOME_PATH_PATTERN, text)) hits.push(m.text)
  const f = finding(
    'ABSOLUTE_PATH',
    'info',
    'content',
    '正文含绝对路径（仅事实，未解析）',
    hits
  )
  return f ? [f] : []
}

function scanResources(resources: SkillScanResource[]): SkillFinding[] {
  const scripts: string[] = []
  const binaries: string[] = []
  for (const r of resources) {
    const rel = String(r.path ?? '').replace(/\\/g, '/')
    const base = rel.split('/').pop() ?? ''
    const dot = base.lastIndexOf('.')
    if (dot <= 0) continue
    const ext = base.slice(dot + 1).toLowerCase()
    if (SCRIPT_EXTENSIONS.has(ext)) scripts.push(rel)
    else if (BINARY_EXTENSIONS.has(ext)) binaries.push(rel)
  }
  const out: SkillFinding[] = []
  const scriptFinding = finding(
    'SCRIPT_RESOURCE',
    'notice',
    'resource',
    '随包资源含脚本文件（仅清单事实，未执行）',
    scripts
  )
  if (scriptFinding) out.push(scriptFinding)
  const binaryFinding = finding(
    'BINARY_RESOURCE',
    'attention',
    'resource',
    '随包资源含二进制或可执行文件（仅清单事实，未执行）',
    binaries
  )
  if (binaryFinding) out.push(binaryFinding)
  return out
}

function scanIgnoredKeys(keys: string[]): SkillFinding[] {
  const cleaned = keys.map((k) => String(k ?? '').trim()).filter(Boolean)
  const f = finding(
    'IGNORED_DECLARATION',
    'info',
    'declaration',
    '这些声明字段本应用不执行',
    cleaned
  )
  return f ? [f] : []
}

/** 扫描一份技能：正文 + 随包资源清单 + 白名单外声明字段 */
export function scanSkill(input: SkillScanInput): SkillScanResult {
  const rawContent = String(input.content ?? '')
  const scanned = rawContent.slice(0, MAX_SCAN_CHARS)
  const resources = input.resources ?? []

  const findings: SkillFinding[] = [
    ...scanContentRules(scanned),
    ...scanUrls(scanned),
    ...scanAbsolutePaths(scanned),
    ...scanResources(resources),
    ...scanIgnoredKeys(input.ignoredKeys ?? [])
  ]
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || a.code.localeCompare(b.code))
    .slice(0, MAX_FINDINGS)

  const counts: Record<SkillFindingLevel, number> = { info: 0, notice: 0, attention: 0 }
  let level: SkillScanLevel = 'none'
  for (const f of findings) {
    counts[f.level] += 1
    if (LEVEL_RANK[f.level] > LEVEL_RANK[level]) level = f.level
  }

  return {
    level,
    findings,
    counts,
    scannedChars: scanned.length,
    resourceCount: resources.length
  }
}
