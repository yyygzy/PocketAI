// SystemPrompt 模板变量渲染（M3.1）
// Phase 2: 基础变量 + {{knowledge}}
// Phase 3: + {{tools}}
// Skills:  + {{skills}}（模板缺省时自动追加到末尾）

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function pad(n: number): string {
  return n < 10 ? '0' + n : String(n)
}

export interface PromptContext {
  userName?: string
  knowledge?: string
  tools?: string
  skills?: string
}

export function renderPrompt(template: string, ctx: PromptContext = {}): string {
  if (!template) return ''

  const now = new Date()
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const weekday = WEEKDAYS[now.getDay()]!

  const map: Record<string, string> = {
    date,
    time,
    weekday,
    user_name: ctx.userName ?? '',
    knowledge: ctx.knowledge ?? '',
    tools: ctx.tools ?? '',
    skills: ctx.skills ?? ''
  }

  const rendered = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(map, key) ? map[key]! : match
  )

  // 兜底：助手启用了技能但模板没写 {{skills}}，自动追加到末尾，保证技能生效
  if (ctx.skills && ctx.skills.trim() && !template.includes('{{skills')) {
    return rendered.trimEnd() + '\n\n' + ctx.skills
  }
  return rendered
}
