// load_skill：把一份技能的正文与自带资源按需交给模型（§236 的第二、三层）
//
// 为什么要有这颗工具：常驻注入的形状是"所有启用技能的全文一起进 system prompt"，
// 而 SKILL.md 那一族标准形状是三层——元数据常驻、正文触发才读、资源再下一层。
// 全量常驻在技能多的助手上是白付的 token，在低配机上还会把窗口挤掉别的东西。
//
// 边界三条（都有用例钉着）：
//  · **只认这一次运行绑定了的技能**（引擎按助手把 skillIds 透传进来，与 kb_search 的 kbIds 同一条通道），
//    没绑定过的技能读不到——这颗工具不是"看库里所有技能"的口子；
//  · 资源路径由 `resolveSkillFilePath` 约束在该技能目录内（`..`、绝对路径、NUL 一律拒），
//    目录里的符号链接不跟；
//  · permission 是 auto：它读的是用户自己存的文本，无外部副作用，与 `fs_read` 同一档；
//    也因此和 `'*'`（只给内置）那条语义天然同源，子级工具面照旧由 permission 决定。
import type { BuiltinTool } from './builtin'
import { skillRepo } from '../db/repositories/skill.repo'
import { listSkillFiles, readSkillFile } from '../skills/skill-files'

/** 同一条技能名撞上两条时给模型看的那一句里的 id 截断长度（够它回选，不够它拼路径） */
const ID_HINT_CHARS = 8

const loadSkillTool: BuiltinTool = {
  schema: {
    id: 'skill.load',
    name: 'load_skill',
    description:
      '取一份技能的完整指令正文（以及它自带的文件清单）。system prompt 里只给了每条按需技能的' +
      '名字与用途；决定要用某一条时调它，传 name 或 id。要看技能自带的参考文件时再传 path' +
      '（path 用返回清单里的相对路径）。参数：skill (string，必填)，path (string，可选)。',
    parameters: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: '技能的名字或 id（不区分大小写）' },
        path: {
          type: 'string',
          description: '技能自带的相对文件路径，例如 references/api.md；不传就只返回正文与文件清单'
        }
      },
      required: ['skill'],
      additionalProperties: false
    },
    source: 'builtin',
    permission: 'auto'
  },
  async execute(args, ctx) {
    const skillIds = ctx?.skillIds ?? []
    if (skillIds.length === 0) throw new Error('这次运行没有绑定任何技能')
    const want = String(args?.skill ?? '')
    if (!want.trim()) throw new Error('skill 不能为空')
    const bound = skillRepo.listEnabledByIds(skillIds)
    const needle = want.trim().toLowerCase()
    const hits = bound.filter((s) => s.id.toLowerCase() === needle || s.name.toLowerCase() === needle)
    if (hits.length === 0) {
      // 把可用清单报回去：模型下一步就能自己纠正，而不是反复试同一个名字
      throw new Error(`没有这条技能或它未启用。可用的有：${bound.map((s) => s.name).join('、') || '（无）'}`)
    }
    if (hits.length > 1) {
      throw new Error(
        `有 ${hits.length} 条同名技能，请改传 id：${hits.map((h) => h.id.slice(0, ID_HINT_CHARS)).join('、')}`
      )
    }
    const skill = hits[0]!
    const rel = args?.path === undefined || args?.path === null ? '' : String(args.path)
    if (rel) {
      const file = readSkillFile(skill.id, rel)
      return JSON.stringify({
        skill: skill.name,
        path: file.path,
        size: file.size,
        truncated: file.truncated,
        content: file.content
      })
    }
    return JSON.stringify({
      skill: skill.name,
      description: skill.description,
      size: skill.content.length,
      // 第三层的入口：把清单给出去，模型才知道"这条技能还带了文件"这件事可以进一步做
      files: listSkillFiles(skill.id),
      content: skill.content
    })
  }
}

export function getSkillTools(): BuiltinTool[] {
  return [loadSkillTool]
}
