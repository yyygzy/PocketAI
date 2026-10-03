// 斜杠（/）与井号（#）触发提示词片段的纯函数
import type { PromptSnippetRecord } from '../../../shared/types'

export type SlashTrigger = '/' | '#' | null

export interface TriggerInfo {
  trigger: SlashTrigger
  query: string
  startPos: number
}

/**
 * 识别输入框末尾是否处于 / 或 # 触发态。
 * 规则：仅在行首或空白字符后触发，避免路径/邮箱误命中。
 * 取光标前最后一个 / 或 #，要求前一字符是行首/空格/换行。
 */
export function getSnippetTrigger(input: string, cursor = input.length): TriggerInfo | null {
  const prefix = input.slice(0, cursor)
  // 从光标前逐个字符倒找，找到最后一个 / 或 #
  for (let i = prefix.length - 1; i >= 0; i--) {
    const ch = prefix[i]
    if (ch === '/' || ch === '#') {
      // 检查 /# 前是否是空白或行首
      const prev = prefix[i - 1]
      if (i === 0 || /\s/.test(prev ?? '')) {
        const query = prefix.slice(i + 1)
        return { trigger: ch, query, startPos: i }
      }
      // 如果前一个不是空白，说明是行中 /#（如路径），不触发
      return null
    }
    // 遇到空白停止搜索（再往前的 /# 不在当前词尾）
    if (ch === undefined || /\s/.test(ch)) break
  }
  return null
}

export interface SlashCommand {
  name: string
  label: string
  template: string
  kind: 'builtin' | 'snippet'
}

/** 把片段记录转为 SlashCommand */
export function snippetToCommand(s: PromptSnippetRecord): SlashCommand {
  return {
    name: `snippet:${s.id}`,
    label: s.title,
    template: s.content,
    kind: 'snippet'
  }
}

/** 按 label 与 template 双侧过滤（不区分大小写） */
export function filterSnippetCommands(cmds: SlashCommand[], query: string): SlashCommand[] {
  const q = query.trim().toLowerCase()
  if (!q) return cmds
  return cmds.filter(
    (c) => c.label.toLowerCase().includes(q) || c.template.toLowerCase().includes(q)
  )
}

/** 内置斜杠指令触发词（显示名/模板走 i18n agent.slash.*） */
export const BUILTIN_SLASH_NAMES = ['summary', 'translate', 'polish', 'explain', 'continue', 'review'] as const

/** 生成内置指令列表（label/template 随界面语言变化） */
export function buildBuiltinSlashCommands(t: (key: string) => string): SlashCommand[] {
  return BUILTIN_SLASH_NAMES.map((name) => ({
    name,
    label: t(`agent.slash.${name}`),
    template: t(`agent.slash.${name}Tpl`),
    kind: 'builtin' as const
  }))
}
